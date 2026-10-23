import {
  type Cuenta,
  ContextoPruebas,
  ventana,
} from './utilidades/app-de-pruebas';
import {
  type Catalogos,
  catalogos,
  prepararBanco,
} from './utilidades/escenario';

type Voluntario = Cuenta & { voluntarioId: string };

/**
 * Rutas dinámicas con Google: trazado por calles tras aceptar (fuera de la
 * transacción) y seguimiento de la siguiente parada.
 */
describe('Trazado y seguimiento de rutas', () => {
  // Zona propia: un solo voluntario disponible aquí recibe todas las ofertas.
  const ZONA = { lat: 2.45, lng: -76.6 };
  const cerca = (d: number) => ({ lat: ZONA.lat + d, lng: ZONA.lng + d });
  // Ejemplo de la documentación de Google: (38.5,-120.2) → (40.7,-120.95) → (43.252,-126.453).
  const POLILINEA = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
  let ctx: ContextoPruebas;
  let admin: Cuenta;
  let asesor: Cuenta;
  let cat: Catalogos;
  let sedes: { seco: string };
  let vol: Voluntario;
  let donante: Cuenta;
  let rutaId: string;

  async function donacionOfrecida(ubicacion: { lat: number; lng: number }) {
    const r = await ctx
      .como(donante)
      .post('/v1/donaciones')
      .send({
        ...ventana(4),
        direccion_recogida: 'Calle 5 # 6-7',
        ubicacion_recogida: ubicacion,
        items: [
          {
            tipo_alimento_id: cat.tipo('ARROZ'),
            cantidad: 10,
            peso_estimado_kg: 10,
          },
        ],
      })
      .expect(201);
    await ctx
      .como(donante)
      .post(`/v1/donaciones/${r.body.id}/publicar`)
      .expect(200);
    const { rows } = await ctx.sql.query<{ id: string; voluntario_id: string }>(
      `SELECT id, voluntario_id FROM asignacion
        WHERE donacion_id = $1 AND estado = 'OFRECIDA'`,
      [r.body.id],
    );
    expect(rows[0].voluntario_id).toBe(vol.voluntarioId);
    return rows[0].id;
  }

  beforeAll(async () => {
    ctx = await ContextoPruebas.crear();
    admin = await ctx.admin();
    asesor = await ctx.asesor();
    cat = await catalogos(ctx, admin);
    sedes = await prepararBanco(ctx, admin, ZONA);
    vol = await ctx.voluntario(admin, cerca(0.001));
    donante = await ctx.cuenta({ nombres: 'Donante seguimiento' });
  });

  afterEach(() => {
    ctx.rutasGoogle.disponible = false;
    ctx.rutasGoogle.respuestaRuta = null;
  });

  afterAll(async () => {
    await ctx.cerrar();
  });

  it('aceptar crea la ruta EN_CURSO y guarda su trazado por calles desde la base del voluntario', async () => {
    ctx.rutasGoogle.disponible = true;
    ctx.rutasGoogle.respuestaRuta = {
      polilinea: POLILINEA,
      distanciaKm: 7.345,
      duracionMin: 20,
      tramosMin: [12, 8],
    };
    const oferta = await donacionOfrecida(cerca(0.01));
    const r = await ctx
      .como(vol)
      .post(`/v1/asignaciones/${oferta}/aceptar`)
      .expect(200);
    rutaId = r.body.ruta.id;

    // Origen (base declarada) → recogida → entrega en la sede, en el orden del planificador.
    const pedido = ctx.rutasGoogle.rutas.at(-1)!;
    expect(pedido).toHaveLength(3);
    expect(pedido[0].lat).toBeCloseTo(cerca(0.001).lat, 6);
    expect(pedido[1].lat).toBeCloseTo(cerca(0.01).lat, 6);

    const ruta = await ctx.como(vol).get(`/v1/rutas/${rutaId}`).expect(200);
    expect(ruta.body.estado).toBe('EN_CURSO');
    expect(ruta.body.proveedor_ruteo).toBe('GOOGLE');
    expect(Number(ruta.body.distancia_total_km)).toBeCloseTo(7.35, 2);
    expect(ruta.body.geometria).toEqual({
      type: 'LineString',
      coordinates: [
        [-120.2, 38.5],
        [-120.95, 40.7],
        [-126.453, 43.252],
      ],
    });
    expect(ruta.body.paradas.at(-1).almacen_id).toBe(sedes.seco);
  });

  it('una nueva recogida reordena la ruta y borra el trazado viejo si Google no responde', async () => {
    const oferta = await donacionOfrecida(cerca(0.005));
    await ctx
      .como(vol)
      .post(`/v1/asignaciones/${oferta}/aceptar`)
      .expect(200);
    const ruta = await ctx.como(vol).get(`/v1/rutas/${rutaId}`).expect(200);
    expect(ruta.body.paradas).toHaveLength(3);
    // Sin trazado vigente el panel une las paradas en línea recta: nunca un orden viejo.
    expect(ruta.body.geometria).toBeNull();
    expect(ruta.body.proveedor_ruteo).toBeNull();
  });

  it('seguimiento: sin posición reciente informa la siguiente parada sin tramo', async () => {
    const r = await ctx
      .como(vol)
      .get(`/v1/rutas/${rutaId}/seguimiento`)
      .expect(200);
    expect(r.body).toMatchObject({ estado: 'EN_CURSO', origen: null, tramo: null });
    expect(r.body.parada.orden).toBe(1);
  });

  it('seguimiento: con la posición actual estima el tramo y lo reusa hasta el plazo', async () => {
    const aqui = cerca(0.002);
    const r = await ctx
      .como(asesor)
      .get(`/v1/rutas/${rutaId}/seguimiento?lat=${aqui.lat}&lng=${aqui.lng}`)
      .expect(200);
    const { parada, tramo } = r.body;
    expect(r.body.origen).toMatchObject({ ...aqui, fuente: 'CONSULTA' });
    expect(tramo.proveedor).toBe('ESTIMADO');
    expect(tramo.trayecto.coordinates).toEqual([
      [aqui.lng, aqui.lat],
      [parada.lng, parada.lat],
    ]);
    expect(tramo.duracion_min).toBeGreaterThan(0);
    expect(Date.parse(tramo.llegada_estimada)).toBeGreaterThan(Date.now());

    // Dentro del plazo no se vuelve a llamar a Google aunque ya esté disponible.
    ctx.rutasGoogle.disponible = true;
    const llamadas = ctx.rutasGoogle.rutas.length;
    const otra = await ctx
      .como(vol)
      .get(`/v1/rutas/${rutaId}/seguimiento?lat=${aqui.lat}&lng=${aqui.lng}`)
      .expect(200);
    expect(otra.body.tramo.calculado_at).toBe(tramo.calculado_at);
    expect(ctx.rutasGoogle.rutas.length).toBe(llamadas);
  });

  it('seguimiento: sin posición en la consulta usa la ultima_ubicacion reciente', async () => {
    await ctx
      .como(vol)
      .post('/v1/voluntario/ubicacion')
      .send(cerca(0.003))
      .expect(200);
    const r = await ctx
      .como(vol)
      .get(`/v1/rutas/${rutaId}/seguimiento`)
      .expect(200);
    expect(r.body.origen.fuente).toBe('ULTIMA_UBICACION');
    expect(r.body.tramo).not.toBeNull();
  });

  it('seguimiento: valida la posición y no muestra rutas ajenas', async () => {
    await ctx
      .como(vol)
      .get(`/v1/rutas/${rutaId}/seguimiento?lat=2.4`)
      .expect(400);
    const ajeno = await ctx.voluntario(admin, { lat: -3.5, lng: -70.1 });
    await ctx
      .como(ajeno)
      .get(`/v1/rutas/${rutaId}/seguimiento`)
      .expect(404);
  });
});
