import { ApiProperty } from '@nestjs/swagger';
import {
  IsLatitude,
  IsLongitude,
  ValidateBy,
  type ValidationOptions,
} from 'class-validator';
import { Prisma } from '../generated/prisma/client';

export interface Coordenada {
  lat: number;
  lng: number;
}

export class CoordenadaDto implements Coordenada {
  @ApiProperty({ example: 4.6533 })
  @IsLatitude()
  lat: number;

  @ApiProperty({ example: -74.0836 })
  @IsLongitude()
  lng: number;
}

/** Rectángulo en grados: límites sur/norte (lat) y oeste/este (lng). */
export interface ZonaServicio {
  sur: number;
  norte: number;
  oeste: number;
  este: number;
}

/**
 * Zona de servicio por omisión: Bogotá y sus municipios vecinos (Soacha, Chía,
 * Cajicá, Cota, Funza, Mosquera, Madrid, La Calera, Sibaté, Tocancipá…). Es
 * un rectángulo aproximado; la app usa los mismos números. Limita la búsqueda
 * de direcciones y los puntos que se guardan (recogida, base del voluntario).
 */
export const ZONA_SERVICIO_BOGOTA: Readonly<ZonaServicio> = Object.freeze({
  sur: 4.44,
  norte: 5.0,
  oeste: -74.3,
  este: -73.95,
});

/**
 * Lee `sur,oeste,norte,este` (formato de la variable ZONA_SERVICIO). `null`
 * si no son cuatro números finitos con sur < norte y oeste < este.
 */
export function parsearZonaServicio(texto: string): ZonaServicio | null {
  const partes = texto.split(',').map((p) => p.trim());
  if (partes.length !== 4 || partes.some((p) => p === '')) return null;
  const [sur, oeste, norte, este] = partes.map(Number);
  if (![sur, oeste, norte, este].every(Number.isFinite)) return null;
  if (sur >= norte || oeste >= este) return null;
  return { sur, oeste, norte, este };
}

let zonaEnCache: Readonly<ZonaServicio> | undefined;

/**
 * Zona de servicio configurada. Los decoradores de validación corren fuera de
 * la inyección de dependencias, así que se lee de process.env.ZONA_SERVICIO
 * la primera vez y se guarda. La configuración (configuracion.ts) ya rechaza
 * un valor inválido al arrancar; aquí uno inválido cae a Bogotá.
 */
export function zonaServicio(): Readonly<ZonaServicio> {
  if (!zonaEnCache) {
    const texto = process.env.ZONA_SERVICIO;
    zonaEnCache =
      (texto ? parsearZonaServicio(texto) : null) ?? ZONA_SERVICIO_BOGOTA;
  }
  return zonaEnCache;
}

/** Solo pruebas: olvida la zona leída para volver a leer process.env. */
export function reiniciarZonaServicio(): void {
  zonaEnCache = undefined;
}

/** ¿El punto está en la zona de servicio configurada? Incluye el borde. */
export function dentroDeZonaServicio(c: Coordenada): boolean {
  const { sur, norte, oeste, este } = zonaServicio();
  return c.lat >= sur && c.lat <= norte && c.lng >= oeste && c.lng <= este;
}

/**
 * Exige que la coordenada esté en la zona de servicio. Solo mira objetos con
 * lat/lng numéricos: la forma y la presencia las validan los demás decoradores.
 */
export function DentroDeZonaServicio(opciones?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'dentroDeZonaServicio',
      validator: {
        validate: (valor: unknown) => {
          if (typeof valor !== 'object' || valor === null) return true;
          const { lat, lng } = valor as Partial<Coordenada>;
          if (typeof lat !== 'number' || typeof lng !== 'number') return true;
          return dentroDeZonaServicio({ lat, lng });
        },
        defaultMessage: () =>
          'El punto debe estar en Bogotá o un municipio vecino.',
      },
    },
    opciones,
  );
}

/** Fragmento SQL de un punto geography(Point,4326). PostGIS recibe (lng, lat). */
export function sqlPunto(c: Coordenada): Prisma.Sql {
  return Prisma.sql`ST_SetSRID(ST_MakePoint(${c.lng}::float8, ${c.lat}::float8), 4326)::geography`;
}

export function sqlPuntoOpcional(c: Coordenada | null | undefined): Prisma.Sql {
  return c ? sqlPunto(c) : Prisma.sql`NULL::geography`;
}

const RADIO_TIERRA_KM = 6371.0088;

/** Distancia geodésica aproximada (haversine) en km, para cálculos en memoria. */
export function distanciaKm(a: Coordenada, b: Coordenada): number {
  const rad = (g: number) => (g * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * RADIO_TIERRA_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Radio (m) dentro del cual se puede registrar la llegada a una parada; la app usa el mismo número. */
export const RADIO_LLEGADA_M = 1000;

/** Velocidad urbana de referencia en Bogotá para el fallback sin Google (§6.3). */
export const VELOCIDAD_URBANA_KMH = 20;

export function minutosEstimados(km: number): number {
  return (km / VELOCIDAD_URBANA_KMH) * 60;
}

/**
 * Decodifica una polilínea codificada de Google (precisión 1e-5) a puntos
 * {lat, lng}. https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
export function decodificarPolilinea(codificada: string): Coordenada[] {
  const puntos: Coordenada[] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  const siguiente = () => {
    let resultado = 0;
    let desplazamiento = 0;
    let byte: number;
    do {
      byte = codificada.charCodeAt(i++) - 63;
      resultado |= (byte & 0x1f) << desplazamiento;
      desplazamiento += 5;
    } while (byte >= 0x20 && i < codificada.length);
    return resultado & 1 ? ~(resultado >> 1) : resultado >> 1;
  };
  while (i < codificada.length) {
    lat += siguiente();
    lng += siguiente();
    puntos.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return puntos;
}
