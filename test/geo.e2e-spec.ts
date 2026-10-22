import { randomUUID } from 'node:crypto';
import { LIMITE_POR_MINUTO } from '../src/modulos/geo/geo.service';
import { type Cuenta, ContextoPruebas } from './utilidades/app-de-pruebas';

/**
 * Búsqueda de direcciones (/v1/geo). Solo lectura: no crea voluntarios ni
 * donaciones, así que no interfiere con los filtros duros de otras suites.
 */
describe('Geo', () => {
  const ZONA = { lat: 10.4, lng: -75.5 };
  let ctx: ContextoPruebas;
  let persona: Cuenta;
  const sesion = randomUUID();

  beforeAll(async () => {
    ctx = await ContextoPruebas.crear();
    persona = await ctx.cuenta({ nombres: 'Geo' });
  });

  afterAll(async () => {
    await ctx.cerrar();
  });

  beforeEach(() => {
    ctx.lugares.disponible = true;
    ctx.lugares.llamadas = [];
  });

  it('exige autenticación', async () => {
    await ctx.http
      .get(`/v1/geo/autocompletar?q=calle 72&sesion=${sesion}`)
      .expect(401);
  });

  it('sin Google responde 503 geo-no-disponible para que el cliente use su respaldo', async () => {
    ctx.lugares.disponible = false;
    const r = await ctx
      .como(persona)
      .get(`/v1/geo/geocodificar?direccion=Calle 72 # 10-34`)
      .expect(503);
    expect(r.body.type).toBe('geo-no-disponible');
    expect(ctx.lugares.llamadas).toHaveLength(0);
  });

  it('valida la consulta', async () => {
    await ctx
      .como(persona)
      .get(`/v1/geo/autocompletar?q=ca&sesion=${sesion}`)
      .expect(400);
    await ctx
      .como(persona)
      .get('/v1/geo/autocompletar?q=calle 72&sesion=no-uuid')
      .expect(400);
    await ctx.como(persona).get('/v1/geo/inversa?lat=95&lng=-74').expect(400);
  });

  it('autocompleta con sesgo hacia el punto dado', async () => {
    ctx.lugares.sugerencias = [
      { place_id: 'ChIJ72', principal: 'Calle 72 #10-34', secundario: 'Bogotá' },
    ];
    const r = await ctx
      .como(persona)
      .get(
        `/v1/geo/autocompletar?q=calle 72&sesion=${sesion}&lat=${ZONA.lat}&lng=${ZONA.lng}`,
      )
      .expect(200);
    expect(r.body.sugerencias).toHaveLength(1);
    expect(ctx.lugares.llamadas[0].args).toEqual(['calle 72', sesion, ZONA]);
  });

  it('sin punto, sesga hacia el banco o el centro de Bogotá', async () => {
    await ctx
      .como(persona)
      .get(`/v1/geo/autocompletar?q=calle 72&sesion=${sesion}`)
      .expect(200);
    const cerca = ctx.lugares.llamadas[0].args[2] as { lat: number };
    expect(cerca.lat).toBeCloseTo(4.6, 0);
  });

  it('devuelve el lugar elegido y rechaza ids con caracteres extraños', async () => {
    ctx.lugares.lugar = {
      place_id: 'ChIJ72',
      direccion: 'Cl. 72 #10-34, Bogotá',
      ubicacion: { lat: 4.6571, lng: -74.0563 },
    };
    const r = await ctx
      .como(persona)
      .get(`/v1/geo/lugares/ChIJ72?sesion=${sesion}`)
      .expect(200);
    expect(r.body.ubicacion).toEqual({ lat: 4.6571, lng: -74.0563 });
    await ctx
      .como(persona)
      .get(`/v1/geo/lugares/a.b?sesion=${sesion}`)
      .expect(404);
  });

  it('geocodifica con precisión y responde 404 si la dirección no existe', async () => {
    ctx.lugares.geocodificacion = {
      direccion: 'Chapinero, Bogotá',
      ubicacion: { lat: 4.6486, lng: -74.0628 },
      precision: 'APPROXIMATE',
    };
    const r = await ctx
      .como(persona)
      .get('/v1/geo/geocodificar?direccion=Chapinero')
      .expect(200);
    expect(r.body.precision).toBe('APPROXIMATE');

    const inversa = await ctx
      .como(persona)
      .get('/v1/geo/inversa?lat=4.6486&lng=-74.0628')
      .expect(200);
    expect(inversa.body).toEqual({ direccion: 'Chapinero, Bogotá' });
    expect(ctx.lugares.llamadas[1].args[0]).toEqual({
      lat: 4.6486,
      lng: -74.0628,
    });

    ctx.lugares.geocodificacion = undefined;
    await ctx
      .como(persona)
      .get('/v1/geo/geocodificar?direccion=No existe 999')
      .expect(404);
  });

  it(`limita a ${LIMITE_POR_MINUTO} consultas por usuario y minuto`, async () => {
    const otra = await ctx.cuenta({ nombres: 'Geo limite' });
    ctx.lugares.geocodificacion = {
      direccion: 'Bogotá',
      ubicacion: { lat: 4.65, lng: -74.08 },
      precision: 'ROOFTOP',
    };
    for (let i = 0; i < LIMITE_POR_MINUTO; i++) {
      await ctx
        .como(otra)
        .get('/v1/geo/geocodificar?direccion=Bogota')
        .expect(200);
    }
    const r = await ctx
      .como(otra)
      .get('/v1/geo/geocodificar?direccion=Bogota')
      .expect(429);
    expect(r.body.type).toBe('demasiadas-solicitudes');
    // El tope es por usuario: los demás siguen buscando.
    await ctx
      .como(persona)
      .get('/v1/geo/geocodificar?direccion=Bogota')
      .expect(200);
  });
});
