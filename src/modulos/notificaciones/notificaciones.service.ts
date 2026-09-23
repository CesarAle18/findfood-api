import { Injectable } from '@nestjs/common';
import { noEncontrado } from '../../comun/http/problema';
import { PrismaService, type Tx } from '../../comun/prisma/prisma.service';
import type { Pagina } from '../../comun/validacion';
import type { canal_notificacion } from '../../generated/prisma/client';
import { Prisma } from '../../generated/prisma/client';
import { renderizarPlantilla } from './plantilla';

export type CodigoNotificacion =
  | 'ASIGNACION_OFRECIDA'
  | 'ASIGNACION_ACEPTADA'
  | 'DONACION_RECOGIDA'
  | 'DONACION_EN_CAMINO'
  | 'DONACION_ENTREGADA'
  | 'DONACION_EXPIRADA'
  | 'ALERTA_VENCIMIENTO'
  | 'VERIFICACION_APROBADA'
  | 'VERIFICACION_RECHAZADA'
  | 'DONACION_CANCELADA'
  | 'DONACION_RECIBIDA'
  | 'DONACION_RECHAZADA';

export interface NuevaNotificacion {
  usuarioId: string;
  codigo: CodigoNotificacion;
  variables?: Record<string, string | number>;
  donacionId?: string | null;
  asignacionId?: string | null;
  data?: Record<string, unknown>;
}

interface TipoNotificacion {
  id: number;
  plantilla_titulo: string;
  plantilla_cuerpo: string;
  canal_default: canal_notificacion;
  activo: boolean;
}

const TTL_TIPOS_MS = 5 * 60_000;

/**
 * La tabla notificacion es a la vez la bandeja del usuario y la cola de envío.
 * Encolar ocurre SIEMPRE dentro de la transacción del hecho que la provoca (§9.3).
 */
@Injectable()
export class NotificacionesService {
  private tipos?: { expira: number; porCodigo: Map<string, TipoNotificacion> };

  constructor(private readonly prisma: PrismaService) {}

  private async tipo(
    tx: Tx,
    codigo: string,
  ): Promise<TipoNotificacion | undefined> {
    if (!this.tipos || this.tipos.expira < Date.now()) {
      const filas = await tx.tipo_notificacion.findMany({
        select: {
          id: true,
          codigo: true,
          plantilla_titulo: true,
          plantilla_cuerpo: true,
          canal_default: true,
          activo: true,
        },
      });
      this.tipos = {
        expira: Date.now() + TTL_TIPOS_MS,
        porCodigo: new Map(filas.map((f) => [f.codigo, f])),
      };
    }
    return this.tipos.porCodigo.get(codigo);
  }

  async encolar(tx: Tx, n: NuevaNotificacion): Promise<void> {
    await this.encolarVarias(tx, [n]);
  }

  async encolarVarias(
    tx: Tx,
    notificaciones: NuevaNotificacion[],
  ): Promise<void> {
    const filas: Prisma.notificacionCreateManyInput[] = [];
    for (const n of notificaciones) {
      const tipo = await this.tipo(tx, n.codigo);
      if (!tipo) throw new Error(`Tipo de notificación ${n.codigo} no existe`);
      if (!tipo.activo) continue;
      filas.push({
        usuario_id: n.usuarioId,
        tipo_notificacion_id: tipo.id,
        canal: tipo.canal_default,
        titulo: renderizarPlantilla(tipo.plantilla_titulo, n.variables).slice(
          0,
          120,
        ),
        cuerpo: renderizarPlantilla(tipo.plantilla_cuerpo, n.variables),
        data: {
          tipo: n.codigo,
          ...(n.donacionId ? { donacion_id: n.donacionId } : {}),
          ...(n.asignacionId ? { asignacion_id: n.asignacionId } : {}),
          ...n.data,
        } as Prisma.InputJsonValue,
        donacion_id: n.donacionId ?? null,
        asignacion_id: n.asignacionId ?? null,
      });
    }
    if (filas.length) await tx.notificacion.createMany({ data: filas });
  }

  // --- Bandeja ----------------------------------------------------------------

  async bandeja(
    usuarioId: string,
    soloNoLeidas: boolean,
    limite: number,
    desplazamiento: number,
  ): Promise<Pagina<unknown> & { no_leidas: number }> {
    const donde: Prisma.notificacionWhereInput = {
      usuario_id: usuarioId,
      ...(soloNoLeidas ? { leida_at: null } : {}),
    };
    const [datos, total, noLeidas] = await Promise.all([
      this.prisma.notificacion.findMany({
        where: donde,
        orderBy: { created_at: 'desc' },
        take: limite,
        skip: desplazamiento,
        select: {
          id: true,
          titulo: true,
          cuerpo: true,
          data: true,
          donacion_id: true,
          asignacion_id: true,
          leida_at: true,
          created_at: true,
          tipo_notificacion: { select: { codigo: true } },
        },
      }),
      this.prisma.notificacion.count({ where: donde }),
      this.prisma.notificacion.count({
        where: { usuario_id: usuarioId, leida_at: null },
      }),
    ]);
    return {
      datos: datos.map(({ tipo_notificacion, ...n }) => ({
        ...n,
        tipo: tipo_notificacion.codigo,
      })),
      total,
      limite,
      desplazamiento,
      no_leidas: noLeidas,
    };
  }

  /** Marcar como leída también evita el push si aún estaba en cola. */
  async marcarLeida(usuarioId: string, id: string): Promise<void> {
    const existe = await this.prisma.notificacion.findFirst({
      where: { id, usuario_id: usuarioId },
      select: { id: true },
    });
    if (!existe) throw noEncontrado('Notificación');
    await this.prisma.notificacion.updateMany({
      where: { id, usuario_id: usuarioId, leida_at: null },
      data: { leida_at: new Date(), estado_envio: 'LEIDA' },
    });
  }

  async marcarTodasLeidas(
    usuarioId: string,
  ): Promise<{ actualizadas: number }> {
    const { count } = await this.prisma.notificacion.updateMany({
      where: { usuario_id: usuarioId, leida_at: null },
      data: { leida_at: new Date(), estado_envio: 'LEIDA' },
    });
    return { actualizadas: count };
  }
}
