import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../comun/prisma/prisma.service';
import type { RangoFechasDto } from './inventario.dto';

const DIAS_POR_DEFECTO = 30;

/** Indicadores del panel (§11): kilos recuperados, tiempos del ciclo, merma, sedes y aceptación. */
@Injectable()
export class KpisService {
  constructor(private readonly prisma: PrismaService) {}

  async resumen(rango: RangoFechasDto) {
    const hasta = rango.hasta ? new Date(rango.hasta) : new Date();
    const desde = rango.desde
      ? new Date(rango.desde)
      : new Date(hasta.getTime() - DIAS_POR_DEFECTO * 86_400_000);

    const [donaciones] = await this.prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT count(*)::int AS creadas,
             count(*) FILTER (WHERE publicada_at IS NOT NULL)::int AS publicadas,
             count(*) FILTER (WHERE estado = 'RECIBIDA')::int AS recibidas,
             count(*) FILTER (WHERE estado = 'RECHAZADA')::int AS rechazadas,
             count(*) FILTER (WHERE estado = 'EXPIRADA')::int AS expiradas,
             count(*) FILTER (WHERE estado = 'CANCELADA')::int AS canceladas,
             coalesce(sum(peso_recibido_kg) FILTER (WHERE estado = 'RECIBIDA'), 0)::float8 AS kg_recuperados,
             round(avg(extract(epoch FROM asignada_at - publicada_at) / 60)
                   FILTER (WHERE asignada_at IS NOT NULL AND publicada_at IS NOT NULL))::int
               AS minutos_hasta_asignacion,
             round(avg(extract(epoch FROM recibida_at - publicada_at) / 60)
                   FILTER (WHERE recibida_at IS NOT NULL AND publicada_at IS NOT NULL))::int
               AS minutos_ciclo_completo
        FROM donacion
       WHERE created_at >= ${desde} AND created_at < ${hasta}`;

    const [asignaciones] = await this.prisma.$queryRaw<
      Record<string, unknown>[]
    >`
      SELECT count(*)::int AS ofertas,
             count(*) FILTER (WHERE aceptada_at IS NOT NULL)::int AS aceptadas,
             count(*) FILTER (WHERE estado = 'RECHAZADA')::int AS rechazadas,
             count(*) FILTER (WHERE estado = 'EXPIRADA')::int AS vencidas,
             count(*) FILTER (WHERE estado = 'ABANDONADA')::int AS abandonadas,
             count(DISTINCT donacion_id)::int AS donaciones_ofrecidas
        FROM asignacion
       WHERE voluntario_id IS NOT NULL
         AND ofrecida_at >= ${desde} AND ofrecida_at < ${hasta}`;

    const [inventario] = await this.prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT coalesce(-sum(peso_kg) FILTER (WHERE tipo IN ('MERMA','VENCIMIENTO')), 0)::float8 AS kg_merma,
             coalesce(-sum(peso_kg) FILTER (WHERE tipo IN ('SALIDA','DEVOLUCION')), 0)::float8 AS kg_distribuidos
        FROM movimiento_inventario
       WHERE created_at >= ${desde} AND created_at < ${hasta}`;

    const porSede = await this.prisma.$queryRaw`
      SELECT a.id, a.nombre, a.tipo::text AS tipo,
             count(r.id)::int AS recepciones,
             coalesce(sum(r.peso_recibido_kg), 0)::float8 AS kg_recibidos,
             coalesce(sum(r.peso_rechazado_kg), 0)::float8 AS kg_rechazados
        FROM almacen a
        LEFT JOIN recepcion_donacion r
               ON r.almacen_id = a.id AND r.fecha_recepcion >= ${desde} AND r.fecha_recepcion < ${hasta}
       GROUP BY a.id
       ORDER BY kg_recibidos DESC`;

    const ofertas = Number(asignaciones.ofertas);
    const publicadas = Number(donaciones.publicadas);
    return {
      desde,
      hasta,
      donaciones,
      asignacion: {
        ...asignaciones,
        tasa_aceptacion: ofertas
          ? Number(asignaciones.aceptadas) / ofertas
          : null,
        ofertas_por_donacion: Number(asignaciones.donaciones_ofrecidas)
          ? ofertas / Number(asignaciones.donaciones_ofrecidas)
          : null,
        tasa_expiracion: publicadas
          ? Number(donaciones.expiradas) / publicadas
          : null,
      },
      inventario,
      por_sede: porSede,
    };
  }
}
