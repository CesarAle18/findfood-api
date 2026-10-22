import { ApiProperty } from '@nestjs/swagger';
import { IsLatitude, IsLongitude } from 'class-validator';
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
