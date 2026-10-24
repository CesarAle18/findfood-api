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

/**
 * Ruteo y trabajo en calle (§8): agrupación, orden de paradas, fallas. Con rutas
 * dinámicas, cada aceptación incorpora la recogida a la ruta EN_CURSO del voluntario;
 * POST /v1/rutas solo lo usa la flota del banco.
 */
describe('Ruteo', () => {
  const ZONA = { lat: 7.1, lng: -73.1 };
  let ctx: ContextoPruebas;
  let admin: Cuenta;
  let asesor: Cuenta;
  let cat: Catalogos;
  let voluntario: Cuenta & { voluntarioId: string };

  /** Crea y publica una donación; la cascada la ofrece al voluntario de la prueba. */
  async function publicada(
    punto: { lat: number; lng: number },
    opciones: { peso?: number; tipo?: string; horas?: number } = {},
  ): Promise<{ id: string; donante: Cuenta; ofertaId: string }> {
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
    const { rows } = await ctx.sql.query<{ id: string; voluntario_id: string }>(
      `SELECT id, voluntario_id FROM asignacion WHERE donacion_id = $1 AND estado = 'OFRECIDA'`,
      [d.body.id],
    );
    expect(rows[0].voluntario_id).toBe(voluntario.voluntarioId);
    return { id: d.body.id, donante, ofertaId: rows[0].id };
  }

  /** Publica y acepta: la donación entra a la ruta dinámica del voluntario. */
  async function asignada(
    punto: { lat: number; lng: number },
    opciones: { peso?: number; tipo?: string; horas?: number } = {},
  ): Promise<{ donacionId: string; rutaId: string }> {
    const { id, ofertaId } = await publicada(punto, opciones);
    const r = await ctx
      .como(voluntario)
      .post(`/v1/asignaciones/${ofertaId}/aceptar`)
      .expect(200);
    expect(r.body.ruta).toMatchObject({ estado: 'EN_CURSO', actualizada: true });
    return { donacionId: id, rutaId: r.body.ruta.id };
  }

  async function ruta(id: string, como: Cuenta = voluntario) {
    return (await ctx.como(como).get(`/v1/rutas/${id}`).expect(200)).body;
  }

  beforeAll(async () => {
    ctx = await ContextoPruebas.crear();
    admin = await ctx.admin();
    asesor = await ctx.asesor();
    cat = await catalogos(ctx, admin);
    await prepararBanco(ctx, admin, ZONA);
  });

  // Una ruta dinámica sigue EN_CURSO hasta la entrega: cada caso usa un voluntario nuevo
  // y apaga a los anteriores para que no compitan por las ofertas.
  beforeEach(async () => {
    await ctx.sql.query(
      `UPDATE voluntario SET disponible = false
        WHERE ST_DWithin(ubicacion_base, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, 60000)`,
      [ZONA.lat, ZONA.lng],
    );
    voluntario = await ctx.voluntario(admin, ZONA, { capacidad_carga_kg: 100 });
  });

  afterAll(async () => {
    await ctx.cerrar();
  });

  it('agrupa las recogidas aceptadas en una ruta y las ordena por vecino más cercano + 2-opt', async () => {
    // Tres puntos en línea: el orden óptimo desde la base es cerca → medio → lejos.
    const lejos = await asignada({ lat: ZONA.lat + 0.018, lng: ZONA.lng });
    const cerca = await asignada({ lat: ZONA.lat + 0.004, lng: ZONA.lng });
    const medio = await asignada({ lat: ZONA.lat + 0.011, lng: ZONA.lng });
    // Una sola ruta activa: cada aceptación la reoptimiza.
    expect(new Set([lejos.rutaId, cerca.rutaId, medio.rutaId]).size).toBe(1);

    const r = await ruta(lejos.rutaId);
    expect(r.estado).toBe('EN_CURSO');
    const recogidas = r.paradas.filter(
      (p: { tipo: string }) => p.tipo === 'RECOGIDA',
    );
    expect(
      recogidas.map((p: { donacion_id: string }) => p.donacion_id),
    ).toEqual([cerca.donacionId, medio.donacionId, lejos.donacionId]);
    expect(r.paradas.at(-1).tipo).toBe('ENTREGA');
    const llegadas = recogidas.map((p: { hora_estimada_llegada: string }) =>
      new Date(p.hora_estimada_llegada).getTime(),
    );
    expect([...llegadas].sort((a, b) => a - b)).toEqual(llegadas);
    expect(r.peso_total_estimado_kg).toBe(60);

    // La ruta dinámica ya está en curso: no se cancela como una planificada.
    const cancelar = await ctx
      .como(voluntario)
      .post(`/v1/rutas/${lejos.rutaId}/cancelar`)
      .expect(409);
    expect(cancelar.body.type).toBe('ruta-no-cancelable');
  });

  it('reglas al aceptar: capacidad de la ruta y asignaciones ajenas', async () => {
    const aqui = await asignada({
      lat: ZONA.lat + 0.001,
      lng: ZONA.lng + 0.001,
    });

    // 20 kg en la ruta + 90 kg superan los 100 kg del vehículo: la oferta se rechaza.
    const pesada = await publicada(
      { lat: ZONA.lat + 0.002, lng: ZONA.lng + 0.002 },
      { peso: 90 },
    );
    const excede = await ctx
      .como(voluntario)
      .post(`/v1/asignaciones/${pesada.ofertaId}/aceptar`)
      .expect(422);
    expect(excede.body.type).toBe('RUTA_SIN_CAPACIDAD');
    const { rows } = await ctx.sql.query<{ estado: string }>(
      `SELECT estado::text FROM asignacion WHERE id = $1`,
      [pesada.ofertaId],
    );
    expect(rows[0].estado).toBe('RECHAZADA');
    const r = await ruta(aqui.rutaId);
    expect(
      r.paradas.map((p: { donacion_id: string | null }) => p.donacion_id),
    ).toEqual([aqui.donacionId, null]);
    expect(r.peso_total_estimado_kg).toBe(20);

    // La donación ya está en la ruta dinámica: no se vuelve a agrupar a mano.
    const reagrupar = await ctx
      .como(voluntario)
      .post('/v1/rutas')
      .send({ donacion_ids: [aqui.donacionId] })
      .expect(409);
    expect(reagrupar.body.type).toBe('asignacion-invalida');

    const otro = await ctx.voluntario(admin, {
      lat: ZONA.lat + 0.3,
      lng: ZONA.lng + 0.3,
    });
    const ajena = await ctx
      .como(otro)
      .post('/v1/rutas')
      .send({ donacion_ids: [aqui.donacionId] })
      .expect(409);
    expect(ajena.body.type).toBe('asignacion-invalida');
    // Tampoco puede aceptar una oferta que no es suya.
    await ctx
      .como(otro)
      .post(`/v1/asignaciones/${pesada.ofertaId}/aceptar`)
      .expect(404);

    await ctx
      .como(pesada.donante)
      .post(`/v1/donaciones/${pesada.id}/cancelar`)
      .send({
        motivo_id: cat.motivo('CANCELACION_DONACION', 'CAMBIO_DE_PLANES'),
      })
      .expect(200);
  });

  it('la flota del banco agrupa con POST /v1/rutas: dispersión y ruta sin iniciar', async () => {
    const aqui = await publicada({
      lat: ZONA.lat + 0.001,
      lng: ZONA.lng + 0.001,
    });
    const alla = await publicada({
      lat: ZONA.lat + 0.08,
      lng: ZONA.lng + 0.001,
    });
    const dispersas = await ctx
      .como(asesor)
      .post('/v1/rutas')
      .send({ donacion_ids: [aqui.id, alla.id], origen: ZONA })
      .expect(422);
    expect(dispersas.body.type).toBe('donaciones-dispersas');

    const flota = await ctx
      .como(asesor)
      .post('/v1/rutas')
      .send({ donacion_ids: [aqui.id], origen: ZONA })
      .expect(201);
    expect(flota.body.estado).toBe('PLANIFICADA');
    const antes = await ctx
      .como(asesor)
      .post(`/v1/paradas/${flota.body.paradas[0].id}/fallida`)
      .send({
        tipo_incidencia_id: cat.tipoIncidencia('DONANTE_AUSENTE'),
        descripcion: 'Nadie abrió en 20 minutos',
      })
      .expect(409);
    expect(antes.body.type).toBe('ruta-no-en-curso');

    // Sin iniciar, el personal la cancela y la donación vuelve a publicarse.
    await ctx
      .como(asesor)
      .post(`/v1/rutas/${flota.body.id}/cancelar`)
      .expect(200);
    for (const d of [aqui, alla]) {
      await ctx
        .como(d.donante)
        .post(`/v1/donaciones/${d.id}/cancelar`)
        .send({
          motivo_id: cat.motivo('CANCELACION_DONACION', 'CAMBIO_DE_PLANES'),
        })
        .expect(200);
    }
  });

  it('una recogida fallida (donante ausente) abre una incidencia y la ruta continúa', async () => {
    const { donacionId: donacion, rutaId } = await asignada({
      lat: ZONA.lat + 0.003,
      lng: ZONA.lng - 0.003,
    });
    const [recogida, entrega] = (await ruta(rutaId)).paradas;

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
    expect((await ruta(rutaId)).estado).toBe('COMPLETADA');
  });

  it('la recogida registra el estado del producto; la entrega lo rechaza (API-10)', async () => {
    const { rutaId } = await asignada({
      lat: ZONA.lat + 0.002,
      lng: ZONA.lng + 0.002,
    });
    const [recogida, entrega] = (await ruta(rutaId)).paradas;

    const evidencia = async (id: string, tipo: string, paradaId: string) =>
      ctx
        .como(voluntario)
        .post('/v1/evidencias')
        .send({
          id,
          tipo,
          ruta: await ctx.ruta(voluntario, 'EVIDENCIA'),
          parada_id: paradaId,
          capturada_at: new Date().toISOString(),
        })
        .expect(201);
    const confirmar = (paradaId: string, extra: Record<string, unknown>) =>
      ctx
        .como(voluntario)
        .post(`/v1/paradas/${paradaId}/confirmar`)
        .send({
          confirmacion_manual: true,
          confirmada_en_dispositivo: new Date().toISOString(),
          ...extra,
        });

    const invalido = await confirmar(recogida.id, {
      peso_confirmado_kg: 18,
      estado_producto: 'EXCELENTE',
    }).expect(400);
    expect(invalido.body.type).toBe('validacion');

    await evidencia(
      'e1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e',
      'RECOGIDA',
      recogida.id,
    );
    const r = await confirmar(recogida.id, {
      peso_confirmado_kg: 18,
      estado_producto: 'REGULAR',
    }).expect(200);
    expect(r.body).toMatchObject({
      estado: 'COMPLETADA',
      estado_producto: 'REGULAR',
    });

    // Repetir la confirmación es un no-op: conserva el estado original.
    const repetida = await confirmar(recogida.id, {
      peso_confirmado_kg: 18,
      estado_producto: 'MALO',
    }).expect(200);
    expect(repetida.body.estado_producto).toBe('REGULAR');

    const enEntrega = await confirmar(entrega.id, {
      estado_producto: 'BUENO',
    }).expect(422);
    expect(enEntrega.body.type).toBe('parada-no-recogida');

    await evidencia(
      'f1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e',
      'ENTREGA',
      entrega.id,
    );
    // null means "not recorded" and is accepted on a delivery.
    await confirmar(entrega.id, { estado_producto: null }).expect(200);
    const detalle = await ruta(rutaId);
    expect(detalle.paradas[0]).toMatchObject({
      id: recogida.id,
      estado_producto: 'REGULAR',
    });
    expect(detalle.paradas[1].estado_producto).toBeNull();
  });

  it('las evidencias solo se registran sobre paradas propias y con rutas de archivo propias', async () => {
    const { rutaId } = await asignada({
      lat: ZONA.lat - 0.002,
      lng: ZONA.lng + 0.002,
    });
    const [recogida] = (await ruta(rutaId)).paradas;
    const intruso = await ctx.cuenta();
    const ajena = await ctx
      .como(intruso)
      .post('/v1/evidencias')
      .send({
        id: 'c1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e',
        tipo: 'RECOGIDA',
        ruta: await ctx.ruta(intruso, 'EVIDENCIA'),
        parada_id: recogida.id,
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
        parada_id: recogida.id,
        capturada_at: new Date().toISOString(),
      })
      .expect(422);
    expect(rutaAjena.body.type).toBe('archivo-invalido');
  });
});
