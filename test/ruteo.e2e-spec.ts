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

/** Ruteo y trabajo en calle (§8): agrupación, orden de paradas, fallas. */
describe('Ruteo', () => {
  const ZONA = { lat: 7.1, lng: -73.1 };
  let ctx: ContextoPruebas;
  let admin: Cuenta;
  let cat: Catalogos;
  let voluntario: Cuenta & { voluntarioId: string };

  async function asignada(
    punto: { lat: number; lng: number },
    opciones: { peso?: number; tipo?: string; horas?: number } = {},
  ): Promise<string> {
    const donante = await ctx.cuenta();
    const d = await ctx
      .como(donante)
      .post('/v1/donaciones')
      .send({
        ...ventana(opciones.horas ?? 4),
        direccion_recogida: 'Carrera 27 # 36-14',
        ubicacion_recogida: punto,
        items: [
          {
            tipo_alimento_id: cat.tipo(opciones.tipo ?? 'GRANOS'),
            cantidad: opciones.peso ?? 20,
            peso_estimado_kg: opciones.peso ?? 20,
          },
        ],
      })
      .expect(201);
    await ctx
      .como(donante)
      .post(`/v1/donaciones/${d.body.id}/publicar`)
      .expect(200);
    const { rows } = await ctx.sql.query<{ id: string }>(
      `SELECT id FROM asignacion WHERE donacion_id = $1 AND estado = 'OFRECIDA'`,
      [d.body.id],
    );
    await ctx
      .como(voluntario)
      .post(`/v1/asignaciones/${rows[0].id}/aceptar`)
      .expect(200);
    return d.body.id;
  }

  beforeAll(async () => {
    ctx = await ContextoPruebas.crear();
    admin = await ctx.admin();
    cat = await catalogos(ctx, admin);
    await prepararBanco(ctx, admin, ZONA);
    voluntario = await ctx.voluntario(admin, ZONA, { capacidad_carga_kg: 100 });
  });

  afterAll(async () => {
    await ctx.cerrar();
  });

  it('agrupa varias recogidas cercanas y las ordena por vecino más cercano + 2-opt', async () => {
    // Tres puntos en línea: el orden óptimo desde la base es cerca → medio → lejos.
    const lejos = await asignada({ lat: ZONA.lat + 0.018, lng: ZONA.lng });
    const cerca = await asignada({ lat: ZONA.lat + 0.004, lng: ZONA.lng });
    const medio = await asignada({ lat: ZONA.lat + 0.011, lng: ZONA.lng });

    const r = await ctx
      .como(voluntario)
      .post('/v1/rutas')
      .send({ donacion_ids: [lejos, cerca, medio], origen: ZONA })
      .expect(201);
    const recogidas = r.body.paradas.filter(
      (p: { tipo: string }) => p.tipo === 'RECOGIDA',
    );
    expect(
      recogidas.map((p: { donacion_id: string }) => p.donacion_id),
    ).toEqual([cerca, medio, lejos]);
    expect(r.body.paradas.at(-1).tipo).toBe('ENTREGA');
    const llegadas = recogidas.map((p: { hora_estimada_llegada: string }) =>
      new Date(p.hora_estimada_llegada).getTime(),
    );
    expect([...llegadas].sort((a, b) => a - b)).toEqual(llegadas);
    expect(r.body.peso_total_estimado_kg).toBe(60);

    // Cancelar una ruta no iniciada libera las asignaciones para reagruparlas.
    await ctx
      .como(voluntario)
      .post(`/v1/rutas/${r.body.id}/cancelar`)
      .expect(200);
    const otra = await ctx
      .como(voluntario)
      .post('/v1/rutas')
      .send({ donacion_ids: [cerca] })
      .expect(201);
    await ctx
      .como(voluntario)
      .post(`/v1/rutas/${otra.body.id}/cancelar`)
      .expect(200);
  });

  it('reglas de agrupación: dispersión, capacidad y asignaciones ajenas', async () => {
    const aqui = await asignada({
      lat: ZONA.lat + 0.001,
      lng: ZONA.lng + 0.001,
    });
    const alla = await asignada({
      lat: ZONA.lat + 0.08,
      lng: ZONA.lng + 0.001,
    });
    const dispersas = await ctx
      .como(voluntario)
      .post('/v1/rutas')
      .send({ donacion_ids: [aqui, alla] })
      .expect(422);
    expect(dispersas.body.type).toBe('donaciones-dispersas');

    const pesada = await asignada(
      { lat: ZONA.lat + 0.002, lng: ZONA.lng + 0.002 },
      { peso: 90 },
    );
    const excede = await ctx
      .como(voluntario)
      .post('/v1/rutas')
      .send({ donacion_ids: [aqui, pesada] })
      .expect(422);
    expect(excede.body.type).toBe('excede-capacidad');

    const otro = await ctx.voluntario(admin, {
      lat: ZONA.lat + 0.3,
      lng: ZONA.lng + 0.3,
    });
    const ajena = await ctx
      .como(otro)
      .post('/v1/rutas')
      .send({ donacion_ids: [aqui] })
      .expect(409);
    expect(ajena.body.type).toBe('asignacion-invalida');
  });

  it('una recogida fallida (donante ausente) abre una incidencia y la ruta continúa', async () => {
    const donacion = await asignada({
      lat: ZONA.lat + 0.003,
      lng: ZONA.lng - 0.003,
    });
    const ruta = await ctx
      .como(voluntario)
      .post('/v1/rutas')
      .send({ donacion_ids: [donacion] })
      .expect(201);
    const [recogida, entrega] = ruta.body.paradas;

    const antes = await ctx
      .como(voluntario)
      .post(`/v1/paradas/${recogida.id}/fallida`)
      .send({
        tipo_incidencia_id: cat.tipoIncidencia('DONANTE_AUSENTE'),
        descripcion: 'Nadie abrió en 20 minutos',
      })
      .expect(409);
    expect(antes.body.type).toBe('ruta-no-en-curso');

    await ctx
      .como(voluntario)
      .post(`/v1/rutas/${ruta.body.id}/iniciar`)
      .expect(200);
    const r = await ctx
      .como(voluntario)
      .post(`/v1/paradas/${recogida.id}/fallida`)
      .send({
        tipo_incidencia_id: cat.tipoIncidencia('DONANTE_AUSENTE'),
        descripcion: 'Nadie abrió en 20 minutos',
      })
      .expect(200);
    expect(r.body.estado).toBe('FALLIDA');

    const incidencias = await ctx
      .como(voluntario)
      .get(`/v1/incidencias?donacion_id=${donacion}`)
      .expect(200);
    expect(incidencias.body.datos[0]).toMatchObject({
      estado: 'ABIERTA',
      parada_id: recogida.id,
      tipo_incidencia: { codigo: 'DONANTE_AUSENTE', bloquea_donacion: true },
    });

    // El banco decide: cancelar la donación (el ADMIN puede en recolección).
    await ctx
      .como(admin)
      .post(`/v1/donaciones/${donacion}/cancelar`)
      .send({
        motivo_id: cat.motivo('CANCELACION_DONACION', 'CANCELADA_POR_BANCO'),
        observacion: 'Donante ausente',
      })
      .expect(200);
    await ctx
      .como(admin)
      .post(`/v1/incidencias/${incidencias.body.datos[0].id}/resolver`)
      .send({ resolucion: 'Donación cancelada por ausencia del donante' })
      .expect(200);

    // Sin nada recogido, la entrega cierra la ruta sin entregar donaciones.
    await ctx
      .como(voluntario)
      .post('/v1/evidencias')
      .send({
        id: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e',
        tipo: 'ENTREGA',
        ruta: await ctx.ruta(voluntario, 'EVIDENCIA'),
        parada_id: entrega.id,
        capturada_at: new Date().toISOString(),
      })
      .expect(201);
    await ctx
      .como(voluntario)
      .post(`/v1/paradas/${entrega.id}/confirmar`)
      .send({
        confirmacion_manual: true,
        confirmada_en_dispositivo: new Date().toISOString(),
      })
      .expect(200);
    const final = await ctx
      .como(voluntario)
      .get(`/v1/rutas/${ruta.body.id}`)
      .expect(200);
    expect(final.body.estado).toBe('COMPLETADA');
  });

  it('las evidencias solo se registran sobre paradas propias y con rutas de archivo propias', async () => {
    const donacion = await asignada({
      lat: ZONA.lat - 0.002,
      lng: ZONA.lng + 0.002,
    });
    const ruta = await ctx
      .como(voluntario)
      .post('/v1/rutas')
      .send({ donacion_ids: [donacion] })
      .expect(201);
    const intruso = await ctx.cuenta();
    const ajena = await ctx
      .como(intruso)
      .post('/v1/evidencias')
      .send({
        id: 'c1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e',
        tipo: 'RECOGIDA',
        ruta: await ctx.ruta(intruso, 'EVIDENCIA'),
        parada_id: ruta.body.paradas[0].id,
        capturada_at: new Date().toISOString(),
      })
      .expect(403);
    expect(ajena.body.type).toBe('evidencia-ajena');

    const rutaAjena = await ctx
      .como(voluntario)
      .post('/v1/evidencias')
      .send({
        id: 'd1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e',
        tipo: 'RECOGIDA',
        ruta: await ctx.ruta(intruso, 'EVIDENCIA'),
        parada_id: ruta.body.paradas[0].id,
        capturada_at: new Date().toISOString(),
      })
      .expect(422);
    expect(rutaAjena.body.type).toBe('archivo-invalido');
    await ctx
      .como(voluntario)
      .post(`/v1/rutas/${ruta.body.id}/cancelar`)
      .expect(200);
  });
});
