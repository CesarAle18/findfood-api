import { reiniciarZonaServicio, ZONA_SERVICIO_BOGOTA } from '../src/comun/geo';
import { type Cuenta, ContextoPruebas } from './utilidades/app-de-pruebas';

/**
 * PATCH /v1/voluntario/perfil: el voluntario aprobado cambia la cadena de frío
 * y la zona de operación (ubicación base + radio). Vehículo, placa y capacidad
 * siguen fijos: los verificó el administrador.
 *
 * Usa la zona de servicio real de Bogotá (como zona-servicio.e2e-spec.ts) y su
 * propia zona en Sibaté. Los voluntarios quedan no disponibles para no
 * competir por las ofertas de otras suites.
 */
describe('Perfil del voluntario', () => {
  const ZONA = { lat: 4.49, lng: -74.26 };
  const OTRA_BASE = { lat: 4.52, lng: -74.23 };
  const MEDELLIN = { lat: 6.24, lng: -75.58 };
  let ctx: ContextoPruebas;
  let admin: Cuenta;
  const zonaAnterior = process.env.ZONA_SERVICIO;

  beforeAll(async () => {
    const { sur, oeste, norte, este } = ZONA_SERVICIO_BOGOTA;
    process.env.ZONA_SERVICIO = `${sur},${oeste},${norte},${este}`;
    reiniciarZonaServicio();
    ctx = await ContextoPruebas.crear();
    admin = await ctx.admin();
  });

  afterAll(async () => {
    await ctx.cerrar();
    if (zonaAnterior === undefined) delete process.env.ZONA_SERVICIO;
    else process.env.ZONA_SERVICIO = zonaAnterior;
    reiniciarZonaServicio();
  });

  /** Voluntario aprobado sin refrigeración, radio 5 km y fuera de servicio. */
  async function voluntario(): Promise<Cuenta> {
    const v = await ctx.voluntario(admin, ZONA, {
      tiene_refrigeracion: false,
      radio_cobertura_km: 5,
    });
    await ctx
      .como(v)
      .patch('/v1/voluntario/estado')
      .send({ disponible: false })
      .expect(200);
    return v;
  }

  it('cambia la cadena de frío, la ubicación base y el radio', async () => {
    const v = await voluntario();
    const r = await ctx
      .como(v)
      .patch('/v1/voluntario/perfil')
      .send({
        tiene_refrigeracion: true,
        ubicacion_base: OTRA_BASE,
        radio_cobertura_km: 12.5,
      })
      .expect(200);
    expect(r.body.id).toBe(v.id);
    expect(r.body.voluntario).toMatchObject({
      tiene_refrigeracion: true,
      radio_cobertura_km: 12.5,
      estado_verificacion: 'APROBADA',
    });
    expect(r.body.voluntario.ubicacion_base.lat).toBeCloseTo(OTRA_BASE.lat, 5);
    expect(r.body.voluntario.ubicacion_base.lng).toBeCloseTo(OTRA_BASE.lng, 5);

    const me = await ctx.como(v).get('/v1/me').expect(200);
    expect(me.body.roles).toContain('VOLUNTARIO');
    expect(me.body.voluntario).toMatchObject({
      tiene_refrigeracion: true,
      radio_cobertura_km: 12.5,
      estado_verificacion: 'APROBADA',
      capacidad_carga_kg: 500,
    });
    expect(me.body.voluntario.ubicacion_base.lat).toBeCloseTo(OTRA_BASE.lat, 5);
    expect(me.body.voluntario.ubicacion_base.lng).toBeCloseTo(OTRA_BASE.lng, 5);
  });

  it('un cambio parcial deja intactos los demás campos', async () => {
    const v = await voluntario();
    const antes = await ctx.como(v).get('/v1/me').expect(200);

    const r = await ctx
      .como(v)
      .patch('/v1/voluntario/perfil')
      .send({ radio_cobertura_km: 8 })
      .expect(200);
    expect(r.body.voluntario.radio_cobertura_km).toBe(8);

    const despues = await ctx.como(v).get('/v1/me').expect(200);
    expect(despues.body.voluntario).toEqual({
      ...antes.body.voluntario,
      radio_cobertura_km: 8,
    });
    expect(despues.body.voluntario.tiene_refrigeracion).toBe(false);
    expect(despues.body.voluntario.ubicacion_base.lat).toBeCloseTo(ZONA.lat, 5);
    expect(despues.body.voluntario.ubicacion_base.lng).toBeCloseTo(ZONA.lng, 5);
  });

  it.each([
    ['placa_vehiculo', 'XYZ987'],
    ['tipo_vehiculo_id', 2],
    ['capacidad_carga_kg', 900],
  ])('rechaza %s: el vehículo no se edita', async (campo, valor) => {
    const v = await voluntario();
    const r = await ctx
      .como(v)
      .patch('/v1/voluntario/perfil')
      .send({ radio_cobertura_km: 7, [campo]: valor })
      .expect(400);
    expect(r.body.type).toBe('validacion');

    // Nada cambió, ni siquiera el campo permitido que venía al lado.
    const me = await ctx.como(v).get('/v1/me').expect(200);
    expect(me.body.voluntario.radio_cobertura_km).toBe(5);
    expect(me.body.voluntario.capacidad_carga_kg).toBe(500);
  });

  it('rechaza una ubicación fuera de la zona de servicio', async () => {
    const v = await voluntario();
    const r = await ctx
      .como(v)
      .patch('/v1/voluntario/perfil')
      .send({ ubicacion_base: MEDELLIN })
      .expect(400);
    expect(r.body.type).toBe('validacion');
    expect(JSON.stringify(r.body)).toContain(
      'El punto debe estar en Bogotá o un municipio vecino.',
    );
  });

  it.each([0, 101])('rechaza un radio de %p km', async (radio) => {
    const v = await voluntario();
    const r = await ctx
      .como(v)
      .patch('/v1/voluntario/perfil')
      .send({ radio_cobertura_km: radio })
      .expect(400);
    expect(r.body.type).toBe('validacion');
  });

  it('un cuerpo sin campos responde 400', async () => {
    const v = await voluntario();
    const r = await ctx
      .como(v)
      .patch('/v1/voluntario/perfil')
      .send({})
      .expect(400);
    expect(r.body.type).toBe('validacion');
  });

  it('un DONANTE sin el rol VOLUNTARIO recibe 403', async () => {
    const donante = await ctx.cuenta({ nombres: 'Donante' });
    const r = await ctx
      .como(donante)
      .patch('/v1/voluntario/perfil')
      .send({ tiene_refrigeracion: true })
      .expect(403);
    expect(r.body).toMatchObject({
      type: 'rol-insuficiente',
      roles_requeridos: ['VOLUNTARIO'],
    });
  });
});
