import { Injectable, Logger } from '@nestjs/common';
import { ConfigApp } from '../../config/configuracion';
import { type Coordenada, dentroDeZonaServicio, zonaServicio } from '../geo';
import { errorGoogle } from './error-google';

export interface Sugerencia {
  place_id: string;
  principal: string;
  secundario: string | null;
}

export interface Lugar {
  place_id: string;
  direccion: string;
  ubicacion: Coordenada;
}

/**
 * `geometry.location_type` de Geocoding. GEOMETRIC_CENTER y APPROXIMATE son
 * centroides (barrio, vía): el cliente debe pedir ajustar el pin, porque ese
 * punto alimenta los filtros duros por cercanía (§6.2).
 */
export type PrecisionGeocodificacion =
  | 'ROOFTOP'
  | 'RANGE_INTERPOLATED'
  | 'GEOMETRIC_CENTER'
  | 'APPROXIMATE';

export interface Geocodificacion {
  direccion: string;
  ubicacion: Coordenada;
  precision: PrecisionGeocodificacion;
}

const URL_AUTOCOMPLETAR = 'https://places.googleapis.com/v1/places:autocomplete';
const URL_LUGAR = 'https://places.googleapis.com/v1/places/';
const URL_GEOCODIFICAR = 'https://maps.googleapis.com/maps/api/geocode/json';

/**
 * Cliente de Places API (New) y Geocoding API para buscar direcciones. Mismo
 * contrato que GoogleRoutesService: nunca lanza, ante cualquier falla devuelve
 * null y quien llama decide el respaldo. No persiste nada: el punto que se
 * guarda es siempre el pin que confirma el usuario. Solo busca dentro de la
 * zona de servicio (Bogotá y municipios vecinos): lo de afuera no existe.
 */
@Injectable()
export class GoogleLugaresService {
  private readonly logger = new Logger(GoogleLugaresService.name);
  private readonly llave?: string;

  constructor(config: ConfigApp) {
    this.llave = config.get('GOOGLE_MAPS_API_KEY');
  }

  get disponible(): boolean {
    return Boolean(this.llave);
  }

  /** Sugerencias dentro de la zona de servicio. `null` si Google no responde. */
  async autocompletar(
    texto: string,
    sesion: string,
    plazoMs = 2_000,
  ): Promise<Sugerencia[] | null> {
    if (!this.llave) return null;
    const { sur, oeste, norte, este } = zonaServicio();
    try {
      const respuesta = await fetch(URL_AUTOCOMPLETAR, {
        method: 'POST',
        signal: AbortSignal.timeout(plazoMs),
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': this.llave,
          'X-Goog-FieldMask':
            'suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat',
        },
        body: JSON.stringify({
          input: texto,
          sessionToken: sesion,
          languageCode: 'es',
          includedRegionCodes: ['co'],
          locationRestriction: {
            rectangle: {
              low: { latitude: sur, longitude: oeste },
              high: { latitude: norte, longitude: este },
            },
          },
        }),
      });
      if (!respuesta.ok) {
        this.logger.warn(await errorGoogle(respuesta), 'Autocomplete falló');
        return null;
      }
      const { suggestions } = (await respuesta.json()) as {
        suggestions?: {
          placePrediction?: {
            placeId?: string;
            structuredFormat?: {
              mainText?: { text?: string };
              secondaryText?: { text?: string };
            };
          };
        }[];
      };
      // Presupuesto (§15.2): las solicitudes de una sesión se cobran al cerrar con detalle().
      this.logger.log({ sesion }, 'Autocomplete consumido');
      return (suggestions ?? []).flatMap(({ placePrediction: p }) =>
        p?.placeId && p.structuredFormat?.mainText?.text
          ? [
              {
                place_id: p.placeId,
                principal: p.structuredFormat.mainText.text,
                secundario: p.structuredFormat.secondaryText?.text ?? null,
              },
            ]
          : [],
      );
    } catch (err) {
      this.logger.warn({ err }, 'Autocomplete no respondió');
      return null;
    }
  }

  /**
   * Dirección y punto de una sugerencia; cierra la sesión de autocompletado.
   * `undefined` si el lugar queda fuera de la zona de servicio.
   */
  async detalle(
    placeId: string,
    sesion: string,
    plazoMs = 2_000,
  ): Promise<Lugar | null | undefined> {
    if (!this.llave) return null;
    try {
      const url = new URL(encodeURIComponent(placeId), URL_LUGAR);
      url.searchParams.set('sessionToken', sesion);
      url.searchParams.set('languageCode', 'es');
      const respuesta = await fetch(url, {
        signal: AbortSignal.timeout(plazoMs),
        headers: {
          'X-Goog-Api-Key': this.llave,
          'X-Goog-FieldMask': 'id,formattedAddress,location',
        },
      });
      if (!respuesta.ok) {
        this.logger.warn(await errorGoogle(respuesta), 'Place Details falló');
        return null;
      }
      const lugar = (await respuesta.json()) as {
        id?: string;
        formattedAddress?: string;
        location?: { latitude?: number; longitude?: number };
      };
      const { latitude: lat, longitude: lng } = lugar.location ?? {};
      if (!lugar.formattedAddress || lat === undefined || lng === undefined) {
        return null;
      }
      this.logger.log({ sesion }, 'Place Details consumido');
      if (!dentroDeZonaServicio({ lat, lng })) return undefined;
      return {
        place_id: lugar.id ?? placeId,
        direccion: lugar.formattedAddress,
        ubicacion: { lat, lng },
      };
    } catch (err) {
      this.logger.warn({ err }, 'Place Details no respondió');
      return null;
    }
  }

  /**
   * Dirección → punto. Devuelve `undefined` si Google respondió sin resultados
   * dentro de la zona de servicio (la dirección no existe para nosotros) y
   * `null` si Google no está disponible.
   */
  async geocodificar(
    direccion: string,
    plazoMs = 2_000,
  ): Promise<Geocodificacion | null | undefined> {
    return this.geocode({ address: direccion }, plazoMs);
  }

  /**
   * Punto → dirección, con la misma convención que geocodificar(). Un punto
   * fuera de la zona de servicio no se consulta: `undefined`.
   */
  async geocodificarInversa(
    c: Coordenada,
    plazoMs = 2_000,
  ): Promise<Geocodificacion | null | undefined> {
    if (this.llave && !dentroDeZonaServicio(c)) return undefined;
    return this.geocode({ latlng: `${c.lat},${c.lng}` }, plazoMs);
  }

  private async geocode(
    consulta: Record<string, string>,
    plazoMs: number,
  ): Promise<Geocodificacion | null | undefined> {
    if (!this.llave) return null;
    try {
      const url = new URL(URL_GEOCODIFICAR);
      for (const [k, v] of Object.entries(consulta)) url.searchParams.set(k, v);
      url.searchParams.set('region', 'co');
      url.searchParams.set('language', 'es');
      if (consulta.address) {
        const { sur, oeste, norte, este } = zonaServicio();
        url.searchParams.set('components', 'country:CO');
        // bounds solo sesga: el filtro de abajo descarta lo que quede afuera.
        url.searchParams.set('bounds', `${sur},${oeste}|${norte},${este}`);
      }
      url.searchParams.set('key', this.llave);
      const respuesta = await fetch(url, {
        signal: AbortSignal.timeout(plazoMs),
      });
      if (!respuesta.ok) {
        this.logger.warn({ status: respuesta.status }, 'Geocoding falló');
        return null;
      }
      const { status, results } = (await respuesta.json()) as {
        status?: string;
        results?: {
          formatted_address?: string;
          geometry?: {
            location?: { lat?: number; lng?: number };
            location_type?: PrecisionGeocodificacion;
          };
        }[];
      };
      this.logger.log({ status }, 'Geocoding consumido');
      if (status === 'ZERO_RESULTS') return undefined;
      if (status !== 'OK') {
        this.logger.warn({ status }, 'Geocoding rechazó la consulta');
        return null;
      }
      for (const r of results ?? []) {
        const { lat, lng } = r.geometry?.location ?? {};
        if (!r.formatted_address || lat === undefined || lng === undefined) {
          continue;
        }
        if (!dentroDeZonaServicio({ lat, lng })) continue;
        return {
          direccion: r.formatted_address,
          ubicacion: { lat, lng },
          precision: r.geometry?.location_type ?? 'APPROXIMATE',
        };
      }
      return undefined;
    } catch (err) {
      this.logger.warn({ err }, 'Geocoding no respondió');
      return null;
    }
  }
}
