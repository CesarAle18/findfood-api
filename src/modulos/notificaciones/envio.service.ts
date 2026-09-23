import { Injectable, Logger } from '@nestjs/common';
import { PrismaService, type Tx } from '../../comun/prisma/prisma.service';
import { type MensajePush, ProveedorPush } from './proveedor-push';

const MAX_INTENTOS = 5;
const LOTE = 100;

interface Pendiente {
  id: string;
  usuario_id: string;
  titulo: string;
  cuerpo: string;
  data: Record<string, unknown> | null;
  canal: 'PUSH' | 'EMAIL' | 'IN_APP';
  intentos: number;
}

/**
 * Tarea enviar_notificaciones (§7): toma PENDIENTE con FOR UPDATE SKIP LOCKED,
 * con espera creciente entre intentos (0, 1, 3, 7, 15 min desde la creación)
 * y FALLIDA al quinto intento. DeviceNotRegistered desactiva el dispositivo.
 */
@Injectable()
export class EnvioNotificacionesService {
  private readonly logger = new Logger(EnvioNotificacionesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly proveedor: ProveedorPush,
  ) {}

  async procesarPendientes(): Promise<{ enviadas: number; fallidas: number }> {
    return this.prisma.$transaction(
      async (tx) => {
        const pendientes = await tx.$queryRaw<Pendiente[]>`
          SELECT id, usuario_id, titulo, cuerpo, data, canal::text AS canal, intentos
            FROM notificacion
           WHERE estado_envio = 'PENDIENTE'
             AND created_at + make_interval(mins => (power(2, intentos)::int - 1)) <= now()
           ORDER BY created_at
           LIMIT ${LOTE}
           FOR UPDATE SKIP LOCKED`;
        if (!pendientes.length) return { enviadas: 0, fallidas: 0 };

        let enviadas = 0;
        let fallidas = 0;
        const ahora = new Date();

        // IN_APP: su única entrega es la bandeja.
        const internas = pendientes.filter((p) => p.canal === 'IN_APP');
        if (internas.length) {
          await tx.notificacion.updateMany({
            where: { id: { in: internas.map((p) => p.id) } },
            data: { estado_envio: 'ENVIADA', enviada_at: ahora },
          });
          enviadas += internas.length;
        }

        const correos = pendientes.filter((p) => p.canal === 'EMAIL');
        if (correos.length) {
          await tx.notificacion.updateMany({
            where: { id: { in: correos.map((p) => p.id) } },
            data: {
              estado_envio: 'FALLIDA',
              error: 'Canal EMAIL sin proveedor configurado',
            },
          });
          fallidas += correos.length;
        }

        const push = pendientes.filter((p) => p.canal === 'PUSH');
        if (!push.length) return { enviadas, fallidas };

        const dispositivos = await tx.dispositivo_push.findMany({
          where: {
            usuario_id: { in: [...new Set(push.map((p) => p.usuario_id))] },
            activo: true,
          },
          select: { id: true, usuario_id: true, token_push: true },
        });

        const envios: {
          notificacion: Pendiente;
          dispositivoId: string;
          mensaje: MensajePush;
        }[] = [];
        for (const n of push) {
          const propios = dispositivos.filter(
            (d) => d.usuario_id === n.usuario_id,
          );
          if (!propios.length) {
            await tx.notificacion.update({
              where: { id: n.id },
              data: {
                estado_envio: 'FALLIDA',
                error: 'Sin dispositivos activos',
              },
            });
            fallidas++;
            continue;
          }
          for (const d of propios) {
            envios.push({
              notificacion: n,
              dispositivoId: d.id,
              mensaje: {
                token: d.token_push,
                titulo: n.titulo,
                cuerpo: n.cuerpo,
                data: { ...n.data, notificacion_id: n.id },
              },
            });
          }
        }
        if (!envios.length) return { enviadas, fallidas };

        let resultados;
        try {
          resultados = await this.proveedor.enviar(
            envios.map((e) => e.mensaje),
          );
        } catch (err) {
          this.logger.warn(
            { err },
            'Proveedor push no disponible; se reintentará',
          );
          const error = err instanceof Error ? err.message : String(err);
          for (const n of new Set(envios.map((e) => e.notificacion))) {
            fallidas += await this.registrarFallo(tx, n, error);
          }
          return { enviadas, fallidas };
        }

        const invalidos = envios
          .filter((_e, i) => {
            const r = resultados[i];
            return !r.ok && r.tokenInvalido;
          })
          .map((e) => e.dispositivoId);
        if (invalidos.length) {
          await tx.dispositivo_push.updateMany({
            where: { id: { in: invalidos } },
            data: { activo: false },
          });
        }

        for (const n of new Set(envios.map((e) => e.notificacion))) {
          const propios = envios
            .map((e, i) => ({ ...e, resultado: resultados[i] }))
            .filter((e) => e.notificacion === n);
          const exito = propios.find((e) => e.resultado.ok);
          if (exito) {
            await tx.notificacion.update({
              where: { id: n.id },
              data: {
                estado_envio: 'ENVIADA',
                enviada_at: ahora,
                dispositivo_push_id: exito.dispositivoId,
                intentos: { increment: 1 },
                error: null,
              },
            });
            await tx.dispositivo_push.updateMany({
              where: {
                id: {
                  in: propios
                    .filter((e) => e.resultado.ok)
                    .map((e) => e.dispositivoId),
                },
              },
              data: { ultimo_uso_at: ahora },
            });
            enviadas++;
          } else {
            const primero = propios[0].resultado;
            const error = primero.ok ? 'desconocido' : primero.error;
            const todosInvalidos = propios.every(
              (e) => !e.resultado.ok && e.resultado.tokenInvalido,
            );
            fallidas += await this.registrarFallo(tx, n, error, todosInvalidos);
          }
        }
        return { enviadas, fallidas };
      },
      { maxWait: 5_000, timeout: 60_000 },
    );
  }

  /** Devuelve 1 si la notificación quedó FALLIDA definitivamente. */
  private async registrarFallo(
    tx: Tx,
    n: Pendiente,
    error: string,
    definitivo = false,
  ): Promise<number> {
    const agotada = definitivo || n.intentos + 1 >= MAX_INTENTOS;
    await tx.notificacion.update({
      where: { id: n.id },
      data: {
        intentos: { increment: 1 },
        error: error.slice(0, 1000),
        ...(agotada ? { estado_envio: 'FALLIDA' as const } : {}),
      },
    });
    return agotada ? 1 : 0;
  }
}
