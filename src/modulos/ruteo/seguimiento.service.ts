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
import type { SeguimientoDto } from './ruteo.dto';

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
