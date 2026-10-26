import { Logger } from '@nestjs/common';
import type { ConfigApp } from '../../config/configuracion';
import { reiniciarZonaServicio } from '../geo';
import { GoogleLugaresService } from './google-lugares.service';
import { GoogleRoutesService } from './google-routes.service';

const config = (llave?: string) =>
  ({ get: () => llave }) as unknown as ConfigApp;

const BOGOTA = { lat: 4.6533, lng: -74.0836 };
const MEDELLIN = { lat: 6.24, lng: -75.58 };
const SESION = '0b9f1c2e-5d7a-4f4e-9c1a-3b2d1e0f9a8b';

function respuesta(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), { status });
}

describe('clientes de Google: nunca lanzan, devuelven null (§6.3)', () => {
  let fetchSimulado: jest.SpyInstance;

  beforeAll(() => {
    Logger.overrideLogger(false);
    // Zona por omisión (Bogotá), sin importar el entorno de quien corre.
    delete process.env.ZONA_SERVICIO;
    reiniciarZonaServicio();
  });
  beforeEach(() => {
    fetchSimulado = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => fetchSimulado.mockRestore());

  describe('GoogleRoutesService', () => {
    it('sin llave no llama a Google', async () => {
      const google = new GoogleRoutesService(config());
      expect(google.disponible).toBe(false);
      expect(await google.matriz([BOGOTA], [BOGOTA])).toBeNull();
      expect(await google.ruta([BOGOTA, BOGOTA])).toBeNull();
      expect(fetchSimulado).not.toHaveBeenCalled();
    });

    it('arma la matriz y deja null los tramos sin ruta', async () => {
      fetchSimulado.mockResolvedValue(
        respuesta([
          {
            originIndex: 0,
            destinationIndex: 0,
            duration: '600s',
            distanceMeters: 4200,
            condition: 'ROUTE_EXISTS',
          },
          { originIndex: 1, destinationIndex: 0, condition: 'ROUTE_NOT_FOUND' },
        ]),
      );
      const google = new GoogleRoutesService(config('llave'));
      expect(await google.matriz([BOGOTA, BOGOTA], [BOGOTA])).toEqual([
        [{ duracionMin: 10, distanciaKm: 4.2 }],
        [null],
      ]);
    });

    it('envía cada API con su forma de waypoint (la matriz lo envuelve, Compute Routes no)', async () => {
      const google = new GoogleRoutesService(config('llave'));
      fetchSimulado.mockResolvedValueOnce(respuesta([]));
      await google.matriz([BOGOTA], [BOGOTA]);
      const matriz = JSON.parse(fetchSimulado.mock.calls[0][1].body as string);
      const punto = { location: { latLng: { latitude: 4.6533, longitude: -74.0836 } } };
      expect(matriz.origins).toEqual([{ waypoint: punto }]);
      expect(matriz.destinations).toEqual([{ waypoint: punto }]);

      fetchSimulado.mockResolvedValueOnce(
        respuesta({
          routes: [
            {
              duration: '900s',
              distanceMeters: 5200,
              polyline: { encodedPolyline: 'abc' },
              legs: [{ duration: '400s' }, { duration: '500s' }],
            },
          ],
        }),
      );
      const otro = { lat: 4.7, lng: -74.05 };
      expect(await google.ruta([BOGOTA, otro, BOGOTA])).toEqual({
        polilinea: 'abc',
        distanciaKm: 5.2,
        duracionMin: 15,
        tramosMin: [400 / 60, 500 / 60],
      });
      const ruta = JSON.parse(fetchSimulado.mock.calls[1][1].body as string);
      expect(ruta.origin).toEqual(punto);
      expect(ruta.destination).toEqual(punto);
      expect(ruta.intermediates).toEqual([
        { location: { latLng: { latitude: 4.7, longitude: -74.05 } } },
      ]);
    });

    it('ante una respuesta de error o un plazo vencido devuelve null', async () => {
      const google = new GoogleRoutesService(config('llave'));
      fetchSimulado.mockResolvedValueOnce(respuesta({}, 429));
      expect(await google.matriz([BOGOTA], [BOGOTA])).toBeNull();
      fetchSimulado.mockRejectedValueOnce(
        new DOMException('plazo', 'TimeoutError'),
      );
      expect(await google.ruta([BOGOTA, BOGOTA])).toBeNull();
    });
  });

  describe('GoogleLugaresService', () => {
    it('sin llave no llama a Google', async () => {
      const google = new GoogleLugaresService(config());
      expect(google.disponible).toBe(false);
      expect(await google.autocompletar('calle 72', SESION)).toBeNull();
      expect(await google.detalle('ChIJ', SESION)).toBeNull();
      expect(await google.geocodificar('calle 72')).toBeNull();
      expect(fetchSimulado).not.toHaveBeenCalled();
    });

    it('autocompleta solo dentro de la zona de servicio', async () => {
      fetchSimulado.mockResolvedValue(
        respuesta({
          suggestions: [
            {
              placePrediction: {
                placeId: 'ChIJ72',
                structuredFormat: {
                  mainText: { text: 'Calle 72 #10-34' },
                  secondaryText: { text: 'Bogotá, Colombia' },
                },
              },
            },
            { queryPrediction: { text: { text: 'calle 72' } } },
          ],
        }),
      );
      const google = new GoogleLugaresService(config('llave'));
      expect(await google.autocompletar('calle 72', SESION)).toEqual([
        {
          place_id: 'ChIJ72',
          principal: 'Calle 72 #10-34',
          secundario: 'Bogotá, Colombia',
        },
      ]);
      const cuerpo = JSON.parse(fetchSimulado.mock.calls[0][1].body as string);
      expect(cuerpo).toMatchObject({
        sessionToken: SESION,
        languageCode: 'es',
        includedRegionCodes: ['co'],
        locationRestriction: {
          rectangle: {
            low: { latitude: 4.44, longitude: -74.3 },
            high: { latitude: 5.0, longitude: -73.95 },
          },
        },
      });
      expect(cuerpo).not.toHaveProperty('locationBias');
    });

    it('trata un lugar fuera de la zona como no encontrado', async () => {
      fetchSimulado.mockResolvedValue(
        respuesta({
          id: 'ChIJmed',
          formattedAddress: 'Cl. 10 #43-20, Medellín, Colombia',
          location: { latitude: MEDELLIN.lat, longitude: MEDELLIN.lng },
        }),
      );
      const google = new GoogleLugaresService(config('llave'));
      expect(await google.detalle('ChIJmed', SESION)).toBeUndefined();
    });

    it('normaliza latitude/longitude de Places a Coordenada', async () => {
      fetchSimulado.mockResolvedValue(
        respuesta({
          id: 'ChIJ72',
          formattedAddress: 'Cl. 72 #10-34, Bogotá, Colombia',
          location: { latitude: 4.6571, longitude: -74.0563 },
        }),
      );
      const google = new GoogleLugaresService(config('llave'));
      expect(await google.detalle('ChIJ72', SESION)).toEqual({
        place_id: 'ChIJ72',
        direccion: 'Cl. 72 #10-34, Bogotá, Colombia',
        ubicacion: { lat: 4.6571, lng: -74.0563 },
      });
      const url = fetchSimulado.mock.calls[0][0] as URL;
      expect(url.pathname).toBe('/v1/places/ChIJ72');
      expect(url.searchParams.get('sessionToken')).toBe(SESION);
    });

    it('geocodifica con la precisión del resultado', async () => {
      fetchSimulado.mockResolvedValue(
        respuesta({
          status: 'OK',
          results: [
            {
              formatted_address: 'Chapinero, Bogotá, Colombia',
              geometry: {
                location: { lat: 4.6486, lng: -74.0628 },
                location_type: 'APPROXIMATE',
              },
            },
          ],
        }),
      );
      const google = new GoogleLugaresService(config('llave'));
      expect(await google.geocodificar('Chapinero')).toEqual({
        direccion: 'Chapinero, Bogotá, Colombia',
        ubicacion: { lat: 4.6486, lng: -74.0628 },
        precision: 'APPROXIMATE',
      });
      const url = fetchSimulado.mock.calls[0][0] as URL;
      expect(url.searchParams.get('components')).toBe('country:CO');
      expect(url.searchParams.get('bounds')).toBe('4.44,-74.3|5,-73.95');
    });

    it('geocodifica al primer resultado dentro de la zona', async () => {
      const resultado = (
        direccion: string,
        c: { lat: number; lng: number },
      ) => ({
        formatted_address: direccion,
        geometry: { location: c, location_type: 'ROOFTOP' },
      });
      const google = new GoogleLugaresService(config('llave'));
      fetchSimulado.mockResolvedValueOnce(
        respuesta({
          status: 'OK',
          results: [
            resultado('Calle 10, Medellín', MEDELLIN),
            resultado('Calle 10, Chía', { lat: 4.86, lng: -74.05 }),
          ],
        }),
      );
      expect(await google.geocodificar('Calle 10')).toEqual({
        direccion: 'Calle 10, Chía',
        ubicacion: { lat: 4.86, lng: -74.05 },
        precision: 'ROOFTOP',
      });
      fetchSimulado.mockResolvedValueOnce(
        respuesta({
          status: 'OK',
          results: [resultado('Calle 10, Medellín', MEDELLIN)],
        }),
      );
      expect(await google.geocodificar('Calle 10')).toBeUndefined();
    });

    it('no consulta la dirección de un punto fuera de la zona', async () => {
      const google = new GoogleLugaresService(config('llave'));
      expect(await google.geocodificarInversa(MEDELLIN)).toBeUndefined();
      expect(fetchSimulado).not.toHaveBeenCalled();
    });

    it('distingue "sin resultados" (undefined) de "no disponible" (null)', async () => {
      const google = new GoogleLugaresService(config('llave'));
      fetchSimulado.mockResolvedValueOnce(
        respuesta({ status: 'ZERO_RESULTS', results: [] }),
      );
      expect(await google.geocodificar('no existe')).toBeUndefined();
      fetchSimulado.mockResolvedValueOnce(
        respuesta({ status: 'OVER_QUERY_LIMIT' }),
      );
      expect(await google.geocodificarInversa(BOGOTA)).toBeNull();
      fetchSimulado.mockResolvedValueOnce(respuesta({}, 500));
      expect(await google.detalle('ChIJ72', SESION)).toBeNull();
      fetchSimulado.mockRejectedValueOnce(new TypeError('fetch failed'));
      expect(await google.autocompletar('calle 72', SESION)).toBeNull();
    });
  });
});
