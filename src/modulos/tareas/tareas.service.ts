import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../comun/prisma/prisma.service';
import { ZONA_HORARIA } from '../../comun/tiempo';
import { ConfigApp } from '../../config/configuracion';
import { UsuariosAdminService } from '../admin/usuarios-admin.service';
import { MotorAsignacionService } from '../asignacion/motor.service';
import { DonacionesService } from '../donaciones/donaciones.service';
import { LotesService } from '../inventario/lotes.service';
import { EnvioNotificacionesService } from '../notificaciones/envio.service';
import { ParametrosService } from '../parametros/parametros.service';

export interface EstadoTarea {
  ultimaEjecucion?: Date;
  ultimaExitosa?: Date;
  ultimoResultado?: unknown;
  ultimoError?: string;
  omitidas: number;
}

/**
 * Reloj dentro del proceso (§7, ADR-03). La lógica vive en los servicios de
 * cada módulo; aquí solo se dispara. Todas las tareas son idempotentes, toman
 * filas con SKIP LOCKED y se basan en marcas de tiempo de la base: un reinicio
 * no pierde nada. Si una ejecución sigue en curso, el ciclo se omite.
 */
@Injectable()
export class TareasService {
  private readonly logger = new Logger(TareasService.name);
  private readonly enCurso = new Set<string>();
  readonly estado = new Map<string, EstadoTarea>();

  constructor(
    private readonly config: ConfigApp,
    private readonly prisma: PrismaService,
    private readonly parametros: ParametrosService,
    private readonly motor: MotorAsignacionService,
    private readonly donaciones: DonacionesService,
    private readonly envio: EnvioNotificacionesService,
    private readonly lotes: LotesService,
    private readonly usuarios: UsuariosAdminService,
  ) {}

  async ejecutar(
    nombre: string,
    trabajo: () => Promise<unknown>,
  ): Promise<void> {
    if (!this.config.get('TAREAS_HABILITADAS')) return;
    const estado = this.estado.get(nombre) ?? { omitidas: 0 };
    this.estado.set(nombre, estado);
    if (this.enCurso.has(nombre)) {
      estado.omitidas++;
      this.logger.warn(
        { tarea: nombre },
        'Ejecución anterior aún en curso: se omite el ciclo',
      );
      return;
    }
    this.enCurso.add(nombre);
    estado.ultimaEjecucion = new Date();
    try {
      const resultado = await trabajo();
      estado.ultimaExitosa = new Date();
      estado.ultimoResultado = resultado;
      estado.ultimoError = undefined;
      this.logger.debug({ tarea: nombre, resultado }, 'Tarea completada');
    } catch (err) {
      estado.ultimoError = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, tarea: nombre }, 'Tarea fallida');
    } finally {
      this.enCurso.delete(nombre);
    }
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'vencer_ofertas' })
  vencerOfertas() {
    return this.ejecutar('vencer_ofertas', () => this.motor.vencerOfertas());
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'expirar_publicaciones' })
  expirarPublicaciones() {
    return this.ejecutar('expirar_publicaciones', () =>
      this.donaciones.expirarPublicacionesVencidas(),
    );
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'enviar_notificaciones' })
  enviarNotificaciones() {
    return this.ejecutar('enviar_notificaciones', () =>
      this.envio.procesarPendientes(),
    );
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'levantar_suspensiones' })
  levantarSuspensiones() {
    return this.ejecutar('levantar_suspensiones', () =>
      this.usuarios.levantarSuspensionesVencidas(),
    );
  }

  @Cron('0 6 * * *', { name: 'alertas_vencimiento', timeZone: ZONA_HORARIA })
  alertasVencimiento() {
    return this.ejecutar('alertas_vencimiento', () =>
      this.lotes.generarAlertasVencimiento(),
    );
  }

  @Cron('0 3 * * *', { name: 'cuentas_sin_confirmar', timeZone: ZONA_HORARIA })
  cuentasSinConfirmar() {
    return this.ejecutar('cuentas_sin_confirmar', async () =>
      this.usuarios.eliminarCuentasSinConfirmar(
        await this.parametros.entero('DIAS_RETENCION_SIN_CONFIRMAR'),
      ),
    );
  }

  @Cron('30 3 * * *', { name: 'purgar_candidatos', timeZone: ZONA_HORARIA })
  purgarCandidatos() {
    return this.ejecutar('purgar_candidatos', async () => {
      const dias = await this.parametros.entero('DIAS_RETENCION_CANDIDATOS');
      const { count } = await this.prisma.candidato_asignacion.deleteMany({
        where: {
          generado_at: { lt: new Date(Date.now() - dias * 86_400_000) },
        },
      });
      return count;
    });
  }
}
