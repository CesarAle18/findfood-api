import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService, type Tx } from '../../comun/prisma/prisma.service';
import { generarCodigo } from '../../comun/codigos';
import {
  type Coordenada,
  distanciaKm,
  minutosEstimados,
} from '../../comun/geo';
import { GoogleRoutesService } from '../../comun/google/google-routes.service';
import { ParametrosService } from '../parametros/parametros.service';
import {
  planificarRutaDinamica,
  type RecogidaDinamica,
} from '../ruteo/planificador-dinamico';
import { TrazabilidadService } from '../../comun/trazabilidad/trazabilidad.service';

interface P {
  id: string;
  donacion_id: string | null;
  orden: number;
  estado: 'PENDIENTE' | 'EN_SITIO' | 'COMPLETADA' | 'FALLIDA' | 'OMITIDA';
  tipo: 'RECOGIDA' | 'ENTREGA';
  lat: number;
  lng: number;
  peso_estimado_kg: number | null;
  peso_confirmado_kg: number | null;
  ventana_recogida_inicio: Date | null;
  ventana_recogida_fin: Date | null;
}
interface D {
  id: string;
  almacen_destino_id: string | null;
  estado: string;
  peso_estimado_kg: number;
  ventana_recogida_inicio: Date;
  ventana_recogida_fin: Date;
  direccion_recogida: string;
  lat: number;
  lng: number;
}
interface R {
  id: string;
  almacen_destino_id: string;
  estado: string;
}
type Resultado =
  | { viable: true; rutaId: string; origen: Coordenada }
  | { viable: false; codigo: string; motivo: string };
const no = (codigo: string, motivo: string): Resultado => ({
  viable: false,
  codigo,
  motivo,
});
const coords = (p: {
  lat: number | null;
  lng: number | null;
}): { lat: number; lng: number } => {
  if (
    p.lat === null ||
    p.lng === null ||
    !Number.isFinite(p.lat) ||
    !Number.isFinite(p.lng)
  ) {
    throw new Error('Coordenadas inválidas para calcular la ruta');
  }

  return {
    lat: p.lat,
    lng: p.lng,
  };
};
const minutos = (
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
) => minutosEstimados(distanciaKm(coords(a), coords(b)));

/**
 * Integración inicial con distancias estimadas: sin llamadas de red dentro de la transacción.
 * El trazado por calles (Google) se calcula después, con trazar().
 */
@Injectable()
export class RutasDinamicasService {
  private readonly logger = new Logger(RutasDinamicasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly google: GoogleRoutesService,
    private readonly parametros: ParametrosService,
    private readonly trazabilidad: TrazabilidadService,
  ) {}

  /**
   * Trazado por calles del tramo pendiente: desde `origen` (la posición con la que se planificó)
   * por las paradas pendientes en el orden ya decidido, hasta la sede. Corre fuera de la
   * transacción y nunca cambia el orden. Si Google no responde, la ruta queda sin trazado y
   * el panel une las paradas en línea recta. Si otra aceptación reordenó las paradas mientras
   * Google respondía, no escribe: ese recálculo es el vigente.
   */
  async trazar(rutaId: string, origen: Coordenada): Promise<void> {
    if (!this.google.disponible) return;
    const paradas = await this.prisma.$queryRaw<
      (Coordenada & { id: string })[]
    >`
      SELECT id, ST_Y(ubicacion::geometry) AS lat, ST_X(ubicacion::geometry) AS lng
        FROM parada_ruta
       WHERE ruta_id = ${rutaId}::uuid AND estado IN ('PENDIENTE','EN_SITIO')
       ORDER BY orden`;
    if (!paradas.length) return;
    const trazado = await this.google.ruta([origen, ...paradas]);
    if (!trazado) return;
    const firma = paradas.map((p) => p.id).join(',');
    const escritas = await this.prisma.$executeRaw`
      UPDATE ruta
         SET geometria = ST_SetSRID(ST_LineFromEncodedPolyline(${trazado.polilinea}), 4326),
             distancia_total_km = ${Math.round(trazado.distanciaKm * 100) / 100}::numeric,
             proveedor_ruteo = 'GOOGLE'
       WHERE id = ${rutaId}::uuid AND estado IN ('PLANIFICADA','EN_CURSO')
         AND (SELECT string_agg(id::text, ',' ORDER BY orden) FROM parada_ruta
               WHERE ruta_id = ${rutaId}::uuid AND estado IN ('PENDIENTE','EN_SITIO')) = ${firma}`;
    if (!escritas)
      this.logger.log(
        { rutaId },
        'Trazado descartado: la ruta cambió mientras Google respondía',
      );
  }

  async incorporar(
    tx: Tx,
    args: {
      voluntarioId: string;
      usuarioId: string;
      donacionId: string;
      asignacionId: string;
      capacidadKg: number;
    },
  ): Promise<Resultado> {
    const [d] = await tx.$queryRaw<D[]>`
      SELECT id, estado::text AS estado, almacen_destino_id,
        peso_estimado_kg::float8 AS peso_estimado_kg, ventana_recogida_inicio,
        ventana_recogida_fin, direccion_recogida,
        ST_Y(ubicacion_recogida::geometry) AS lat, ST_X(ubicacion_recogida::geometry) AS lng
      FROM donacion WHERE id = ${args.donacionId}::uuid FOR UPDATE`;
    if (!d || d.estado !== 'PUBLICADA')
      return no('DONACION_NO_DISPONIBLE', 'La donación ya no está disponible');
    if (!d.almacen_destino_id)
      return no('DONACION_SIN_SEDE', 'La donación no tiene sede de destino');
    const [destino] = await tx.$queryRaw<
      { id: string; lat: number; lng: number; direccion: string }[]
    >`
      SELECT id, direccion, ST_Y(ubicacion::geometry) AS lat,
             ST_X(ubicacion::geometry) AS lng FROM almacen WHERE id = ${d.almacen_destino_id}::uuid`;
    if (!destino)
      return no('SEDE_NO_DISPONIBLE', 'La sede de destino no existe');
    const [v] = await tx.$queryRaw<
      { lat: number | null; lng: number | null }[]
    >`
      SELECT ST_Y(COALESCE(CASE WHEN ultima_ubicacion_at > now() - interval '30 minutes' THEN ultima_ubicacion END, ubicacion_base)::geometry) AS lat,
             ST_X(COALESCE(CASE WHEN ultima_ubicacion_at > now() - interval '30 minutes' THEN ultima_ubicacion END, ubicacion_base)::geometry) AS lng
      FROM voluntario WHERE id = ${args.voluntarioId}::uuid`;
    if (v?.lat == null || v?.lng == null)
      return no(
        'VOLUNTARIO_SIN_UBICACION',
        'Actualiza tu ubicación antes de aceptar',
      );
    const activas = await tx.$queryRaw<R[]>`
      SELECT id, almacen_destino_id, estado::text AS estado FROM ruta
      WHERE voluntario_id = ${args.voluntarioId}::uuid AND estado IN ('PLANIFICADA','EN_CURSO')
      ORDER BY created_at FOR UPDATE`;
    if (activas.length > 1)
      throw new Error('Datos inconsistentes: múltiples rutas activas');
    const ruta = activas[0];
    if (ruta && ruta.almacen_destino_id !== d.almacen_destino_id)
      return no('RUTA_SEDE_DISTINTA', 'La ruta activa termina en otra sede');
    const paradas = ruta
      ? await tx.$queryRaw<P[]>`
      SELECT p.id,p.donacion_id,p.orden,p.tipo::text AS tipo,p.estado::text AS estado,
        ST_Y(p.ubicacion::geometry) AS lat, ST_X(p.ubicacion::geometry) AS lng,
        d.peso_estimado_kg::float8 AS peso_estimado_kg,
        p.peso_confirmado_kg::float8 AS peso_confirmado_kg,
        d.ventana_recogida_inicio,d.ventana_recogida_fin
      FROM parada_ruta p LEFT JOIN donacion d ON d.id=p.donacion_id
      WHERE p.ruta_id=${ruta.id}::uuid ORDER BY p.orden FOR UPDATE OF p`
      : [];
    if (paradas.some((p) => p.tipo === 'ENTREGA' && p.estado !== 'PENDIENTE'))
      return no('RUTA_ENTREGA_INICIADA', 'La entrega a la sede ya comenzó');
    if (paradas.some((p) => p.tipo === 'RECOGIDA' && p.estado === 'EN_SITIO'))
      return no(
        'RUTA_PARADA_EN_SITIO',
        'Finaliza la atención de la parada actual antes de aceptar otra recogida',
      );
    const recogidas = paradas.filter(
      (p) => p.tipo === 'RECOGIDA' && p.donacion_id,
    ) as P[];
    const max = await this.parametros.entero('MAX_PARADAS_POR_RUTA');
    const ahora = new Date();
    const pendiente = recogidas.filter((p) => p.estado === 'PENDIENTE');
    const puntos = [
      coords(v),
      ...pendiente.map(coords),
      coords(d),
      coords(destino),
    ];
    const duracionesMin = puntos.map((a) =>
      puntos.map((b) => (a === b ? 0 : minutos(a, b))),
    );
    const conversion = (p: P): RecogidaDinamica => ({
      id: p.id,
      donacionId: p.donacion_id!,
      estado: p.estado,
      orden: p.orden,
      pesoEstimadoKg: Number(p.peso_estimado_kg),
      pesoRealKg: p.peso_confirmado_kg,
      ventanaInicio: p.ventana_recogida_inicio!,
      ventanaFin: p.ventana_recogida_fin!,
    });
    const plan = planificarRutaDinamica({
      ahora,
      sedeRutaId: ruta?.almacen_destino_id ?? d.almacen_destino_id,
      sedeDonacionId: d.almacen_destino_id,
      capacidadKg: args.capacidadKg,
      maxRecogidas: max,
      recogidas: recogidas.map(conversion),
      nueva: {
        id: 'nueva',
        donacionId: d.id,
        pesoEstimadoKg: Number(d.peso_estimado_kg),
        ventanaInicio: d.ventana_recogida_inicio,
        ventanaFin: d.ventana_recogida_fin,
      },
      duracionesMin,
      servicioMin: 5,
      entregaIniciada: false,
    });
    if (!plan.viable) return no(plan.codigo, plan.motivo);
    // No se cambia el orden ni el contenido de paradas ya cerradas.
    const previo = new Map(recogidas.map((p) => [p.donacion_id!, p]));
    const finalIds = plan.ordenDonacionesPendientes;
    let rutaId = ruta?.id;
    if (!rutaId) {
      const [creada] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO ruta(codigo,voluntario_id,almacen_destino_id,fecha_programada,
          estado,iniciada_at,duracion_estimada_min,peso_total_estimado_kg,proveedor_ruteo)
        VALUES(${generarCodigo('RUT')},${args.voluntarioId}::uuid,${destino.id}::uuid,
          CURRENT_DATE,'EN_CURSO',now(),${Math.round(plan.duracionEstimadaMin)},
          ${Number(d.peso_estimado_kg)},NULL) RETURNING id`;
      rutaId = creada.id;
      await this.trazabilidad.registrar(tx, {
        ambito: 'RUTA',
        entidad: { rutaId },
        nuevo: 'EN_CURSO',
        usuarioId: args.usuarioId,
      });
    }
    const entrega = paradas.find((p) => p.tipo === 'ENTREGA');
    // Los recorridos realizados deben formar un prefijo de la ruta.
    // No se cambia ni se renumera una parada ya atendida.
    const cerradas = paradas.filter((p) => p.estado !== 'PENDIENTE');
    const ordenesCerradas = cerradas.map((p) => p.orden).sort((a, b) => a - b);
    if (ordenesCerradas.some((orden, i) => orden !== i + 1)) {
      return no(
        'RUTA_ORDEN_INCONSISTENTE',
        'Las paradas atendidas no ocupan las primeras posiciones consecutivas',
      );
    }
    const ordenInicial = ordenesCerradas.length;
    // Sacar primero TODAS las paradas pendientes del rango definitivo.
    // Solo empleamos órdenes positivos, libres y admitidos por SMALLINT.
    const mayorOrden = Math.max(0, ...paradas.map((p) => p.orden));
    const posicionesTemporales = pendiente.length + (entrega ? 1 : 0);
    const ordenFinalMaximo = ordenInicial + finalIds.length + 1;
    if (Math.max(mayorOrden + posicionesTemporales, ordenFinalMaximo) > 32767) {
      return no(
        'RUTA_SIN_ORDENES_DISPONIBLES',
        'Se alcanzó el límite de posiciones de la ruta',
      );
    }
    if (
      finalIds.length !== pendiente.length + 1 ||
      new Set(finalIds).size !== finalIds.length ||
      !finalIds.includes(d.id) ||
      pendiente.some((p) => !finalIds.includes(p.donacion_id!))
    ) {
      return no(
        'RUTA_PLAN_INCONSISTENTE',
        'El planificador devolvió un conjunto inesperado de recogidas',
      );
    }
    for (let i = 0; i < pendiente.length; i++) {
      await tx.$executeRaw`
        UPDATE parada_ruta SET orden = ${mayorOrden + i + 1}::smallint
        WHERE id = ${pendiente[i].id}::uuid AND estado = 'PENDIENTE'`;
    }
    if (entrega) {
      await tx.$executeRaw`
        UPDATE parada_ruta SET orden = ${mayorOrden + pendiente.length + 1}::smallint
        WHERE id = ${entrega.id}::uuid AND estado = 'PENDIENTE'`;
    }
    let idx = ordenInicial;
    for (let i = 0; i < finalIds.length; i++) {
      const id = finalIds[i];
      idx++;
      const llegada = new Date(ahora.getTime() + plan.llegadasMin[i] * 60000);
      const existente = previo.get(id);
      if (existente) {
        await tx.$executeRaw`UPDATE parada_ruta SET orden=${idx}::smallint,hora_estimada_llegada=${llegada}
          WHERE id=${existente.id}::uuid AND estado='PENDIENTE'`;
      } else {
        await tx.$executeRaw`
          INSERT INTO parada_ruta(ruta_id,orden,tipo,donacion_id,direccion,ubicacion,hora_estimada_llegada)
          SELECT ${rutaId}::uuid,${idx}::smallint,'RECOGIDA',d.id,d.direccion_recogida,d.ubicacion_recogida,${llegada}
          FROM donacion d WHERE d.id=${d.id}::uuid`;
      }
    }
    const llegadaSede = new Date(
      ahora.getTime() + plan.llegadasMin[finalIds.length] * 60000,
    );
    if (entrega)
      await tx.$executeRaw`UPDATE parada_ruta SET orden=${idx + 1}::smallint,hora_estimada_llegada=${llegadaSede}
      WHERE id=${entrega.id}::uuid`;
    else
      await tx.$executeRaw`INSERT INTO parada_ruta(ruta_id,orden,tipo,almacen_id,direccion,ubicacion,hora_estimada_llegada)
      SELECT ${rutaId}::uuid,${idx + 1}::smallint,'ENTREGA',a.id,a.direccion,a.ubicacion,${llegadaSede}
      FROM almacen a WHERE a.id=${destino.id}::uuid`;
    const kg = recogidas.reduce(
      (acc, p) =>
        acc +
        (p.estado === 'FALLIDA' || p.estado === 'OMITIDA'
          ? 0
          : Number(
              p.estado === 'COMPLETADA'
                ? (p.peso_confirmado_kg ?? p.peso_estimado_kg)
                : p.peso_estimado_kg,
            )),
      Number(d.peso_estimado_kg),
    );
    // El trazado anterior ya no sigue el nuevo orden: trazar() lo recalcula tras la transacción.
    await tx.$executeRaw`UPDATE ruta SET duracion_estimada_min=${Math.round(plan.duracionEstimadaMin)},
      peso_total_estimado_kg=${kg},proveedor_ruteo=NULL,geometria=NULL,distancia_total_km=NULL
      WHERE id=${rutaId}::uuid`;
    await this.trazabilidad.registrar(tx, {
      ambito: 'RUTA',
      entidad: { rutaId },
      anterior: ruta?.estado ?? undefined,
      nuevo: 'EN_CURSO',
      usuarioId: args.usuarioId,
      metadata: { incorporacion_donacion_id: d.id, reoptimizadas: finalIds },
    });
    return { viable: true, rutaId, origen: coords(v) };
  }
}
