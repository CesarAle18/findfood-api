import { Injectable } from '@nestjs/common';
import { esPersonal, type UsuarioAutenticado } from '../../comun/auth/tipos';
import {
  type Coordenada,
  decodificarPolilinea,
  distanciaKm,
  minutosEstimados,
} from '../../comun/geo';
import { GoogleRoutesService } from '../../comun/google/google-routes.service';
import { noEncontrado } from '../../comun/http/problema';
import { PrismaService } from '../../comun/prisma/prisma.service';
import { minutosEntre } from '../../comun/tiempo';
import { Prisma } from '../../generated/prisma/client';
import type { SeguimientoDto } from './ruteo.dto';
import { type FaseSeguimiento, PARADA_ABIERTA, ventanaDonante } from './seguimiento-donacion';

/** Una ultima_ubicacion más vieja que esto no sirve como posición actual. */
const UBICACION_RECIENTE_MIN = 30;
/** Cada cuánto se recalcula con Google, como máximo, el tramo de una ruta. */
export const RECALCULO_MS = 120_000;
/** Un salto mayor que esto desde el último cálculo lo invalida (desvío o posición corregida). */
export const DESVIO_KM = 2;
const MAX_CACHE = 500;

/** Lo mínimo de una parada para estimar el tramo hacia ella. */
export interface ParadaDestino extends Coordenada {
  id: string;
}

export interface ParadaSeguimiento extends ParadaDestino {
  orden: number;
  tipo: string;
  estado: string;
  direccion: string;
}

export interface Tramo {
  trayecto: { type: 'LineString'; coordinates: [number, number][] };
  distancia_km: number;
  duracion_min: number;
  llegada_estimada: string;
  proveedor: 'GOOGLE' | 'ESTIMADO';
  calculado_at: string;
}

/** Respuesta de GET /v1/donaciones/:id/seguimiento (API-06). */
export interface SeguimientoDonacion {
  donacion_id: string;
  estado_donacion: string;
  activo: boolean;
  fase: FaseSeguimiento | null;
  /**
   * Solo dentro de la ventana y con la posición visible: es el canal Realtime ruta:<id>
   * que puede escuchar. Camino al banco es null mientras queden recogidas de otros donantes.
   */
  ruta_id: string | null;
  /** Paradas abiertas antes del destino del donante. Nunca se dice cuáles. */
  paradas_antes: number;
  recogida: { direccion: string; lat: number; lng: number };
  banco: { id: string; nombre: string; direccion: string; lat: number; lng: number } | null;
  voluntario_posicion: { lat: number; lng: number; at: string; fuente: 'ULTIMA_UBICACION' } | null;
  tramo: Tramo | null;
}

interface FilaSeguimientoDonacion extends UltimaUbicacion {
  estado_donacion: string;
  donante_usuario_id: string;
  direccion: string;
  rec_lat: number;
  rec_lng: number;
  ruta_id: string | null;
  ruta_estado: string | null;
  recogida_id: string | null;
  recogida_estado: string | null;
  recogida_destino_lat: number | null;
  recogida_destino_lng: number | null;
  antes_recogida: number;
  entrega_id: string | null;
  entrega_estado: string | null;
  entrega_destino_lat: number | null;
  entrega_destino_lng: number | null;
  antes_entrega: number;
  otras_recogidas: number;
  almacen_id: string | null;
  almacen_nombre: string | null;
  almacen_direccion: string | null;
  almacen_lat: number | null;
  almacen_lng: number | null;
}

export interface Calculo {
  paradaId: string;
  origen: Coordenada;
  at: number;
  tramo: Tramo;
}

/** voluntario.ultima_ubicacion leída con ST_Y/ST_X, y su hora. */
export interface UltimaUbicacion {
  lat: number | null;
  lng: number | null;
  ultima_at: Date | null;
}

/** La ultima_ubicacion si tiene UBICACION_RECIENTE_MIN o menos; si no, null. */
export function posicionReciente(
  u: UltimaUbicacion,
  ahora = new Date(),
): { lat: number; lng: number; at: Date } | null {
  if (!u.ultima_at || u.lat === null || u.lng === null) return null;
  if (minutosEntre(u.ultima_at, ahora) > UBICACION_RECIENTE_MIN) return null;
  return { lat: u.lat, lng: u.lng, at: u.ultima_at };
}

/** ¿Sirve el cálculo guardado para esta parada y esta posición? */
export function vigente(
  calculo: Calculo | undefined,
  paradaId: string,
  origen: Coordenada,
  ahora: number,
): calculo is Calculo {
  return (
    !!calculo &&
    calculo.paradaId === paradaId &&
    ahora - calculo.at < RECALCULO_MS &&
    distanciaKm(calculo.origen, origen) < DESVIO_KM
  );
}

/**
 * Seguimiento de una ruta EN_CURSO: camino y llegada estimada desde la posición del
 * voluntario hasta su siguiente parada. La posición la envía quien consulta (el panel la
 * recibe por Realtime, §9.2) o, si no, es la ultima_ubicacion reciente. Google se consulta
 * como máximo cada RECALCULO_MS por ruta; entre cálculos la llegada estimada es una hora
 * absoluta que sigue valiendo. Sin Google: línea recta y velocidad urbana de referencia.
 */
@Injectable()
export class SeguimientoService {
  private readonly calculos = new Map<string, Calculo>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly google: GoogleRoutesService,
  ) {}

  async seguimiento(usuario: UsuarioAutenticado, rutaId: string, dto: SeguimientoDto) {
    const [ruta] = await this.prisma.$queryRaw<
      {
        estado: string;
        voluntario_usuario_id: string | null;
        lat: number | null;
        lng: number | null;
        ultima_at: Date | null;
      }[]
    >`
      SELECT r.estado::text AS estado, v.usuario_id AS voluntario_usuario_id,
             ST_Y(v.ultima_ubicacion::geometry) AS lat, ST_X(v.ultima_ubicacion::geometry) AS lng,
             v.ultima_ubicacion_at AS ultima_at
        FROM ruta r LEFT JOIN voluntario v ON v.id = r.voluntario_id
       WHERE r.id = ${rutaId}::uuid`;
    if (!ruta || (!esPersonal(usuario) && ruta.voluntario_usuario_id !== usuario.id)) {
      throw noEncontrado('Ruta');
    }
    const vacio = { ruta_id: rutaId, estado: ruta.estado, parada: null, origen: null, tramo: null };
    if (ruta.estado !== 'EN_CURSO') return vacio;

    const [parada] = await this.prisma.$queryRaw<ParadaSeguimiento[]>`
      SELECT id, orden, tipo::text AS tipo, estado::text AS estado, direccion,
             ST_Y(ubicacion::geometry) AS lat, ST_X(ubicacion::geometry) AS lng
        FROM parada_ruta
       WHERE ruta_id = ${rutaId}::uuid AND estado IN ('PENDIENTE','EN_SITIO')
       ORDER BY orden LIMIT 1`;
    if (!parada) return vacio;

    const reciente = posicionReciente(ruta);
    const origen =
      dto.lat !== undefined && dto.lng !== undefined
        ? { lat: dto.lat, lng: dto.lng, fuente: 'CONSULTA' as const }
        : reciente
          ? { lat: reciente.lat, lng: reciente.lng, fuente: 'ULTIMA_UBICACION' as const }
          : null;
    if (!origen) return { ...vacio, parada };

    const tramo = await this.tramoHacia(rutaId, parada, origen);
    return { ...vacio, parada, origen, tramo };
  }

  /**
   * Seguimiento de una donación por su donante (API-06): dónde va el voluntario y cuándo
   * llega a su punto de recogida (HACIA_RECOGIDA) o al banco (HACIA_BANCO), mientras dure
   * la ventana de ventanaDonante() (la misma de Realtime).
   *
   * Privacidad: de las demás paradas de la ruta solo se informa cuántas hay antes del
   * destino, nunca su dirección, id ni coordenadas. Por eso el tramo se calcula solo si
   * el destino es la siguiente parada: el camino a otra pasaría por casas ajenas.
   *
   * Camino al banco tampoco se informa dónde va el voluntario (ni ruta_id, ni posición,
   * ni tramo) mientras le queden recogidas de otros donantes: estando en una de ellas su
   * posición revelaría esa dirección. El donante ve la fase y cuántas paradas faltan.
   *
   * No recibe la posición en la consulta: la caché del tramo es una por ruta y la
   * comparten el voluntario y el panel, y un donante no debe poder alterarla. El origen
   * es la ultima_ubicacion reciente del voluntario.
   */
  async seguimientoDonacion(
    usuario: UsuarioAutenticado,
    donacionId: string,
  ): Promise<SeguimientoDonacion> {
    // La recogida de la donación en su ruta (EN_CURSO primero, luego la más reciente), la
    // ENTREGA de mayor orden de esa ruta con su sede (la misma que mira
    // fn_rt_es_donante_de_ruta) y la ultima_ubicacion del voluntario. Los estados abiertos
    // van como parámetros (PARADA_ABIERTA) y se comparan con el enum leído como texto.
    const abiertas = Prisma.join(PARADA_ABIERTA);
    const [f] = await this.prisma.$queryRaw<FilaSeguimientoDonacion[]>`
      SELECT d.estado::text AS estado_donacion, dn.usuario_id AS donante_usuario_id,
             d.direccion_recogida AS direccion,
             ST_Y(d.ubicacion_recogida::geometry) AS rec_lat,
             ST_X(d.ubicacion_recogida::geometry) AS rec_lng,
             r.id AS ruta_id, r.estado::text AS ruta_estado,
             rec.id AS recogida_id, rec.estado::text AS recogida_estado,
             ST_Y(rec.ubicacion::geometry) AS recogida_destino_lat,
             ST_X(rec.ubicacion::geometry) AS recogida_destino_lng,
             (SELECT count(*)::int FROM parada_ruta o
               WHERE o.ruta_id = r.id AND o.orden < rec.orden
                 AND o.estado::text IN (${abiertas})) AS antes_recogida,
             ent.id AS entrega_id, ent.estado::text AS entrega_estado,
             ST_Y(ent.ubicacion::geometry) AS entrega_destino_lat,
             ST_X(ent.ubicacion::geometry) AS entrega_destino_lng,
             (SELECT count(*)::int FROM parada_ruta o
               WHERE o.ruta_id = r.id AND o.orden < ent.orden
                 AND o.estado::text IN (${abiertas})) AS antes_entrega,
             (SELECT count(*)::int FROM parada_ruta o
               WHERE o.ruta_id = r.id AND o.tipo = 'RECOGIDA' AND o.id <> rec.id
                 AND o.estado::text IN (${abiertas})) AS otras_recogidas,
             a.id AS almacen_id, a.nombre AS almacen_nombre, a.direccion AS almacen_direccion,
             ST_Y(a.ubicacion::geometry) AS almacen_lat, ST_X(a.ubicacion::geometry) AS almacen_lng,
             ST_Y(v.ultima_ubicacion::geometry) AS lat, ST_X(v.ultima_ubicacion::geometry) AS lng,
             v.ultima_ubicacion_at AS ultima_at
        FROM donacion d
        JOIN donante dn ON dn.id = d.donante_id
        LEFT JOIN LATERAL (
              SELECT p.id, p.ruta_id, p.orden, p.estado, p.ubicacion
                FROM parada_ruta p JOIN ruta rr ON rr.id = p.ruta_id
               WHERE p.donacion_id = d.id AND p.tipo = 'RECOGIDA'
               ORDER BY (rr.estado = 'EN_CURSO') DESC, rr.created_at DESC
               LIMIT 1) rec ON true
        LEFT JOIN ruta r ON r.id = rec.ruta_id
        LEFT JOIN LATERAL (
              SELECT e.id, e.orden, e.estado, e.ubicacion, e.almacen_id
                FROM parada_ruta e
               WHERE e.ruta_id = r.id AND e.tipo = 'ENTREGA'
               ORDER BY e.orden DESC
               LIMIT 1) ent ON true
        LEFT JOIN almacen a ON a.id = ent.almacen_id
        LEFT JOIN voluntario v ON v.id = r.voluntario_id
       WHERE d.id = ${donacionId}::uuid`;
    if (!f || (!esPersonal(usuario) && f.donante_usuario_id !== usuario.id)) {
      throw noEncontrado('Donación');
    }

    const { activo, fase, posicion_visible } = ventanaDonante({
      ruta_estado: f.ruta_estado,
      recogida_estado: f.recogida_estado,
      entrega_estado: f.entrega_estado,
      donacion_estado: f.estado_donacion,
      otras_recogidas_abiertas: f.otras_recogidas,
    });
    const respuesta: SeguimientoDonacion = {
      donacion_id: donacionId,
      estado_donacion: f.estado_donacion,
      activo: false,
      fase: null,
      ruta_id: null,
      paradas_antes: 0,
      recogida: { direccion: f.direccion, lat: f.rec_lat, lng: f.rec_lng },
      banco: f.almacen_id
        ? {
            id: f.almacen_id,
            nombre: f.almacen_nombre!,
            direccion: f.almacen_direccion!,
            lat: f.almacen_lat!,
            lng: f.almacen_lng!,
          }
        : null,
      voluntario_posicion: null,
      tramo: null,
    };
    if (!activo || !fase) return respuesta;
    const paradasAntes = fase === 'HACIA_RECOGIDA' ? f.antes_recogida : f.antes_entrega;
    if (!posicion_visible) return { ...respuesta, activo, fase, paradas_antes: paradasAntes };

    // Dentro de la ventana la ruta, la recogida y la entrega existen.
    const destino =
      fase === 'HACIA_RECOGIDA'
        ? { id: f.recogida_id!, lat: f.recogida_destino_lat!, lng: f.recogida_destino_lng! }
        : { id: f.entrega_id!, lat: f.entrega_destino_lat!, lng: f.entrega_destino_lng! };
    const reciente = posicionReciente(f);
    const tramo =
      reciente && paradasAntes === 0
        ? await this.tramoHacia(f.ruta_id!, destino, { lat: reciente.lat, lng: reciente.lng })
        : null;
    return {
      ...respuesta,
      activo,
      fase,
      ruta_id: f.ruta_id,
      paradas_antes: paradasAntes,
      voluntario_posicion: reciente
        ? {
            lat: reciente.lat,
            lng: reciente.lng,
            at: reciente.at.toISOString(),
            fuente: 'ULTIMA_UBICACION',
          }
        : null,
      tramo,
    };
  }

  /**
   * Tramo desde `origen` hasta `parada`, que debe ser la siguiente parada abierta de la
   * ruta: la caché es una por ruta y la comparten el voluntario, el panel y el donante.
   */
  private async tramoHacia(
    rutaId: string,
    parada: ParadaDestino,
    origen: Coordenada,
  ): Promise<Tramo> {
    const ahora = Date.now();
    const previo = this.calculos.get(rutaId);
    return vigente(previo, parada.id, origen, ahora)
      ? previo.tramo
      : this.calcular(rutaId, parada, origen, ahora);
  }

  private async calcular(
    rutaId: string,
    parada: ParadaDestino,
    origen: Coordenada,
    ahora: number,
  ): Promise<Tramo> {
    const destino = { lat: parada.lat, lng: parada.lng };
    const google = await this.google.ruta([origen, destino], 3_000);
    const puntos = google ? decodificarPolilinea(google.polilinea) : [origen, destino];
    const distancia = google?.distanciaKm ?? distanciaKm(origen, destino);
    const duracion = google?.duracionMin ?? minutosEstimados(distancia);
    const tramo: Tramo = {
      trayecto: { type: 'LineString', coordinates: puntos.map((p) => [p.lng, p.lat]) },
      distancia_km: Math.round(distancia * 100) / 100,
      duracion_min: Math.round(duracion),
      llegada_estimada: new Date(ahora + duracion * 60_000).toISOString(),
      proveedor: google ? 'GOOGLE' : 'ESTIMADO',
      calculado_at: new Date(ahora).toISOString(),
    };
    if (this.calculos.size >= MAX_CACHE) {
      this.calculos.delete(this.calculos.keys().next().value!);
    }
    this.calculos.set(rutaId, { paradaId: parada.id, origen, at: ahora, tramo });
    return tramo;
  }
}
