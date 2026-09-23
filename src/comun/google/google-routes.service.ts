import { Injectable, Logger } from '@nestjs/common';
import { ConfigApp } from '../../config/configuracion';
import type { Coordenada } from '../geo';

export interface Tramo {
  duracionMin: number;
  distanciaKm: number;
}

export interface RutaCalculada {
  polilinea: string;
  distanciaKm: number;
  duracionMin: number;
  tramosMin: number[];
}

const URL_MATRIZ =
  'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
const URL_RUTAS = 'https://routes.googleapis.com/directions/v2:computeRoutes';

function waypoint(c: Coordenada) {
  return {
    waypoint: { location: { latLng: { latitude: c.lat, longitude: c.lng } } },
  };
}

function segundos(duracion: string | undefined): number {
  return duracion ? Number.parseFloat(duracion.replace('s', '')) : Number.NaN;
}

/**
 * Cliente de Google Routes API (ADR-08). Nunca bloquea la operación: ante
 * falta de llave, error, cuota o plazo vencido devuelve null y quien llama usa
 * la distancia geodésica (§6.3).
 */
@Injectable()
export class GoogleRoutesService {
  private readonly logger = new Logger(GoogleRoutesService.name);
  private readonly llave?: string;

  constructor(config: ConfigApp) {
    this.llave = config.get('GOOGLE_MAPS_API_KEY');
  }

  get disponible(): boolean {
    return Boolean(this.llave);
  }

  /** Matriz origen × destino con tráfico. `null` si Google no está disponible. */
  async matriz(
    origenes: Coordenada[],
    destinos: Coordenada[],
    plazoMs = 2_000,
  ): Promise<(Tramo | null)[][] | null> {
    if (!this.llave || !origenes.length || !destinos.length) return null;
    try {
      const respuesta = await fetch(URL_MATRIZ, {
        method: 'POST',
        signal: AbortSignal.timeout(plazoMs),
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': this.llave,
          'X-Goog-FieldMask':
            'originIndex,destinationIndex,duration,distanceMeters,condition',
        },
        body: JSON.stringify({
          origins: origenes.map(waypoint),
          destinations: destinos.map(waypoint),
          travelMode: 'DRIVE',
          routingPreference: 'TRAFFIC_AWARE',
        }),
      });
      if (!respuesta.ok) {
        this.logger.warn(
          { status: respuesta.status },
          'Route Matrix falló; fallback geodésico',
        );
        return null;
      }
      const elementos = (await respuesta.json()) as {
        originIndex?: number;
        destinationIndex?: number;
        duration?: string;
        distanceMeters?: number;
        condition?: string;
      }[];
      const matriz: (Tramo | null)[][] = origenes.map(() =>
        destinos.map(() => null),
      );
      for (const e of elementos) {
        const o = e.originIndex ?? 0;
        const d = e.destinationIndex ?? 0;
        const s = segundos(e.duration);
        if (e.condition === 'ROUTE_EXISTS' && Number.isFinite(s)) {
          matriz[o][d] = {
            duracionMin: s / 60,
            distanciaKm: (e.distanceMeters ?? 0) / 1000,
          };
        }
      }
      // Presupuesto (§15.2, §16): elementos consumidos por llamada.
      this.logger.log(
        { elementos: origenes.length * destinos.length },
        'Route Matrix consumida',
      );
      return matriz;
    } catch (err) {
      this.logger.warn(
        { err },
        'Route Matrix no respondió; fallback geodésico',
      );
      return null;
    }
  }

  /** Ruta por los puntos en el orden dado (el primero es el origen, el último el destino). */
  async ruta(
    puntos: Coordenada[],
    plazoMs = 5_000,
  ): Promise<RutaCalculada | null> {
    if (!this.llave || puntos.length < 2) return null;
    try {
      const respuesta = await fetch(URL_RUTAS, {
        method: 'POST',
        signal: AbortSignal.timeout(plazoMs),
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': this.llave,
          'X-Goog-FieldMask':
            'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.duration',
        },
        body: JSON.stringify({
          origin: waypoint(puntos[0]),
          destination: waypoint(puntos[puntos.length - 1]),
          intermediates: puntos.slice(1, -1).map(waypoint),
          travelMode: 'DRIVE',
          routingPreference: 'TRAFFIC_AWARE',
          polylineEncoding: 'ENCODED_POLYLINE',
        }),
      });
      if (!respuesta.ok) {
        this.logger.warn({ status: respuesta.status }, 'Compute Routes falló');
        return null;
      }
      const { routes } = (await respuesta.json()) as {
        routes?: {
          duration?: string;
          distanceMeters?: number;
          polyline?: { encodedPolyline?: string };
          legs?: { duration?: string }[];
        }[];
      };
      const r = routes?.[0];
      if (!r?.polyline?.encodedPolyline) return null;
      return {
        polilinea: r.polyline.encodedPolyline,
        distanciaKm: (r.distanceMeters ?? 0) / 1000,
        duracionMin: segundos(r.duration) / 60,
        tramosMin: (r.legs ?? []).map((l) => segundos(l.duration) / 60),
      };
    } catch (err) {
      this.logger.warn({ err }, 'Compute Routes no respondió');
      return null;
    }
  }
}
