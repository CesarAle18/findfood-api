import { reiniciarZonaServicio, ZONA_SERVICIO_BOGOTA } from '../src/comun/geo';
import {
  type Cuenta,
  ContextoPruebas,
  ventana,
} from './utilidades/app-de-pruebas';
import { type Catalogos, catalogos, enDias } from './utilidades/escenario';

/**
 * Zona de servicio (Bogotá y municipios vecinos): los puntos que se guardan
 * fuera de ella responden 400. Solo deja borradores y solicitudes sin aprobar,
 * así que no compite con los voluntarios ni las donaciones de otras suites.
 * entorno.ts amplía la zona a toda Colombia para las demás suites; esta usa
 * la real de Bogotá. Cada archivo tiene su propio process.env y su propio
 * registro de módulos (la zona leída se guarda en geo.ts), y entorno.ts corre
 * de nuevo antes de cada archivo, así que el cambio no sale de esta suite.
 */
describe('Zona de servicio', () => {
  const CHIA = { lat: 4.86, lng: -74.05 };
  const MEDELLIN = { lat: 6.24, lng: -75.58 };
  const MENSAJE = 'El punto debe estar en Bogotá o un municipio vecino.';
  let ctx: ContextoPruebas;
  let donante: Cuenta;
  let cat: Catalogos;
  const zonaAnterior = process.env.ZONA_SERVICIO;

  beforeAll(async () => {
    const { sur, oeste, norte, este } = ZONA_SERVICIO_BOGOTA;
    process.env.ZONA_SERVICIO = `${sur},${oeste},${norte},${este}`;
    reiniciarZonaServicio();
    ctx = await ContextoPruebas.crear();
    donante = await ctx.cuenta({ nombres: 'Donante zona' });
    cat = await catalogos(ctx, donante);
  });

  afterAll(async () => {
    await ctx.cerrar();
    if (zonaAnterior === undefined) delete process.env.ZONA_SERVICIO;
    else process.env.ZONA_SERVICIO = zonaAnterior;
    reiniciarZonaServicio();
  });

  const borrador = (ubicacion_recogida: unknown) => ({
    titulo: 'Excedente de panadería',
    ...ventana(4),
    direccion_recogida: 'Carrera 10 # 12-30, Chía',
    ubicacion_recogida,
    items: [
      {
        tipo_alimento_id: cat.tipo('PAN'),
        cantidad: 3,
        peso_estimado_kg: 3,
        fecha_vencimiento: enDias(5),
      },
    ],
  });

  it('acepta una recogida en un municipio vecino y rechaza una en otra ciudad', async () => {
    const r = await ctx
      .como(donante)
      .post('/v1/donaciones')
      .send(borrador(CHIA))
      .expect(201);
    expect(r.body.ubicacion_recogida).toEqual(CHIA);

    const fuera = await ctx
      .como(donante)
      .post('/v1/donaciones')
      .send(borrador(MEDELLIN))
      .expect(400);
    expect(JSON.stringify(fuera.body)).toContain(MENSAJE);

    // La edición valida igual; sin ubicación, no la exige.
    await ctx
      .como(donante)
      .patch(`/v1/donaciones/${r.body.id}`)
      .send({ ubicacion_recogida: MEDELLIN })
      .expect(400);
    await ctx
      .como(donante)
      .patch(`/v1/donaciones/${r.body.id}`)
      .send({ titulo: 'Excedente de panadería (2)' })
      .expect(200);
  });

  it('rechaza la base de un voluntario fuera de la zona', async () => {
    const persona = await ctx.cuenta({ nombres: 'Vol fuera de zona' });
    const r = await ctx
      .como(persona)
      .post('/v1/voluntario/solicitud')
      .send({
        tipo_vehiculo_id: 3,
        placa_vehiculo: 'ZON123',
        url_foto_vehiculo: await ctx.ruta(persona, 'VEHICULO'),
        capacidad_carga_kg: 100,
        tiene_refrigeracion: false,
        fecha_nacimiento: '1990-05-10',
        ubicacion_base: MEDELLIN,
        radio_cobertura_km: 10,
        documento_frente: await ctx.ruta(persona, 'DOCUMENTO_IDENTIDAD'),
      })
      .expect(400);
    expect(JSON.stringify(r.body)).toContain(MENSAJE);
  });
});
