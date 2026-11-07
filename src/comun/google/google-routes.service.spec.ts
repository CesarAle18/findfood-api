import { ConfigApp } from '../../config/configuracion';
import { GoogleRoutesService } from './google-routes.service';

describe('GoogleRoutesService', () => {
  const puntos = [
    { lat: 4.6, lng: -74.1 },
    { lat: 4.65, lng: -74.05 },
    { lat: 4.7, lng: -74 },
  ];
  const ubicacion = (i: number) => ({
    location: {
      latLng: { latitude: puntos[i].lat, longitude: puntos[i].lng },
    },
  });
  let servicio: GoogleRoutesService;

  beforeEach(() => {
    servicio = new GoogleRoutesService({
      get: () => 'clave-de-prueba',
    } as unknown as ConfigApp);
  });

  afterEach(() => jest.restoreAllMocks());

  it('envía Waypoint directamente en origen, destino e intermedios de rutas', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          routes: [
            {
              duration: '120s',
              distanceMeters: 1000,
              polyline: { encodedPolyline: 'ruta' },
              legs: [{ duration: '120s' }],
            },
          ],
        }),
      ),
    );
    expect(await servicio.ruta(puntos)).toEqual({
      polilinea: 'ruta',
      distanciaKm: 1,
      duracionMin: 2,
      tramosMin: [2],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.origin).toEqual(ubicacion(0));
    expect(body.destination).toEqual(ubicacion(2));
    expect(body.intermediates).toEqual([ubicacion(1)]);
  });

  it('conserva el contenedor waypoint requerido por la matriz', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            originIndex: 0,
            destinationIndex: 0,
            condition: 'ROUTE_EXISTS',
            duration: '120s',
            distanceMeters: 1000,
          },
        ]),
      ),
    );
    expect(await servicio.matriz([puntos[0]], [puntos[2]])).toEqual([
      [{ duracionMin: 2, distanciaKm: 1 }],
    ]);
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.origins).toEqual([{ waypoint: ubicacion(0) }]);
    expect(body.destinations).toEqual([{ waypoint: ubicacion(2) }]);
  });
});
