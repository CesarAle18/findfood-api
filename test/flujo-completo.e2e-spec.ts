import { fechaBogota } from '../src/comun/tiempo';
import { EnvioNotificacionesService } from '../src/modulos/notificaciones/envio.service';
import {
  type Cuenta,
  ContextoPruebas,
  ventana,
} from './utilidades/app-de-pruebas';
import {
  type Catalogos,
  catalogos,
  enDias,
  prepararBanco,
} from './utilidades/escenario';

/**
 * Criterio "flujo completo" (§3.2): creación → recepción con su trazabilidad,
 * pasando por la cascada, la ruta, la confirmación en calle, el inventario FEFO.
 */
describe('Flujo completo de una donación', () => {
  const ZONA = { lat: 4.65, lng: -74.08 };
  let ctx: ContextoPruebas;
  let admin: Cuenta;
  let asesor: Cuenta;
  let donante: Cuenta;
  let cercano: Cuenta & { voluntarioId: string };
  let lejano: Cuenta & { voluntarioId: string };
  let cat: Catalogos;
  let sedes: { seco: string; refrigerado: string };

  let donacionId: string;
  let ofertaId: string;
  let rutaId: string;
  let recogidaId: string;
  let entregaId: string;
  let loteId: string;
  let voluntarioAsignado: Cuenta & { voluntarioId: string };

  beforeAll(async () => {
    ctx = await ContextoPruebas.crear();
    admin = await ctx.admin();
    asesor = await ctx.asesor();
    donante = await ctx.cuenta({ nombres: 'Doña Donante' });
    cat = await catalogos(ctx, donante);
    sedes = await prepararBanco(ctx, admin, ZONA);
    cercano = await ctx.voluntario(admin, {
      lat: ZONA.lat + 0.002,
      lng: ZONA.lng + 0.002,
    });
    lejano = await ctx.voluntario(admin, {
      lat: ZONA.lat + 0.03,
      lng: ZONA.lng + 0.03,
    });
  });

  afterAll(async () => {
    await ctx.cerrar();
  });

  it('el donante crea el borrador con productos', async () => {
    const r = await ctx
      .como(donante)
      .post('/v1/donaciones')
      .send({
        titulo: 'Excedente de mercado',
        ...ventana(4),
        direccion_recogida: 'Calle 63 # 11-40',
        ubicacion_recogida: ZONA,
        items: [
          {
            tipo_alimento_id: cat.tipo('ARROZ'),
            cantidad: 6,
            peso_estimado_kg: 6,
            fecha_vencimiento: enDias(200),
          },
          // Vence hoy (hora de Bogotá): pesa en la urgencia (§6.5).
          {
            tipo_alimento_id: cat.tipo('PAN'),
            cantidad: 4,
            peso_estimado_kg: 4,
            fecha_vencimiento: fechaBogota(),
          },
        ],
      })
      .expect(201);
    donacionId = r.body.id;
    expect(r.body).toMatchObject({
      estado: 'BORRADOR',
      peso_estimado_kg: 10,
      requiere_refrigeracion: false,
      ubicacion_recogida: ZONA,
    });
    expect(r.body.items).toHaveLength(2);
    expect(r.body.codigo).toMatch(/^DON-\d{6}-[A-Z0-9]{5}$/);
  });

  it('publicar fija urgencia, sede y plazos, e inicia la cascada con el mejor candidato', async () => {
    const r = await ctx
      .como(donante)
      .post(`/v1/donaciones/${donacionId}/publicar`)
      .expect(200);
    expect(r.body.estado).toBe('PUBLICADA');
    expect(r.body.almacen_destino.id).toBe(sedes.seco);
    expect(r.body.score_urgencia).toBeGreaterThan(0.36); // 0,6 · (1 − h/72) con h < 24
    expect(r.body.oferta_en_curso).toBe(true);
    const plazo =
      new Date(r.body.expira_publicacion_at).getTime() -
      new Date(r.body.publicada_at).getTime();
    expect(plazo).toBe(30 * 60_000);

    const candidatos = await ctx
      .como(asesor)
      .get(`/v1/donaciones/${donacionId}/candidatos`)
      .expect(200);
    expect(
      candidatos.body.map(
        (c: { voluntario: { id: string } }) => c.voluntario.id,
      ),
    ).toEqual(
      expect.arrayContaining([cercano.voluntarioId, lejano.voluntarioId]),
    );
    const primero = candidatos.body.find(
      (c: { posicion: number }) => c.posicion === 1,
    );
    expect(primero.ofrecido).toBe(true);
    // Mismo historial y misma carga: gana la proximidad.
    expect(primero.voluntario.id).toBe(cercano.voluntarioId);

    // El mensaje de Realtime al panel sale del disparador del DDL (§9.1).
    const { rows } = await ctx.sql.query(
      `SELECT payload FROM realtime.messages WHERE topic = 'banco:donaciones' AND payload->>'id' = $1`,
      [donacionId],
    );
    expect(rows.map((m) => m.payload.estado)).toContain('PUBLICADA');
  });

  it('la oferta llega al voluntario sin datos de contacto del donante', async () => {
    const r = await ctx
      .como(cercano)
      .get('/v1/asignaciones/ofertas')
      .expect(200);
    const oferta = r.body.find(
      (o: { donacion_id: string }) => o.donacion_id === donacionId,
    );
    expect(oferta).toMatchObject({
      estado: 'OFRECIDA',
      contacto_telefono: null,
    });
    expect(oferta.productos).toHaveLength(2);
    ofertaId = oferta.id;

    const { rows } = await ctx.sql.query(
      `SELECT n.titulo, n.cuerpo FROM notificacion n JOIN tipo_notificacion t ON t.id = n.tipo_notificacion_id
        WHERE n.usuario_id = $1 AND t.codigo = 'ASIGNACION_OFRECIDA'`,
      [cercano.id],
    );
    expect(rows[0].cuerpo).toMatch(/Tienes 10 minutos para responder/);
  });

  it('rechazar ofrece de inmediato al siguiente candidato', async () => {
    await ctx
      .como(cercano)
      .post(`/v1/asignaciones/${ofertaId}/rechazar`)
      .send({ motivo_id: cat.motivo('RECHAZO_ASIGNACION', 'SIN_TIEMPO') })
      .expect(200);
    const r = await ctx
      .como(lejano)
      .get('/v1/asignaciones/ofertas')
      .expect(200);
    const oferta = r.body.find(
      (o: { donacion_id: string }) => o.donacion_id === donacionId,
    );
    expect(oferta.estado).toBe('OFRECIDA');
    ofertaId = oferta.id;
    voluntarioAsignado = lejano;

    // Responder dos veces la misma oferta no hace nada.
    const repetida = await ctx
      .como(cercano)
      .post(`/v1/asignaciones/${ofertaId}/aceptar`)
      .expect(404);
    expect(repetida.body.type).toBe('no-encontrado');
  });

  it('aceptar asigna la donación y el donante ve al voluntario', async () => {
    await ctx
      .como(lejano)
      .post(`/v1/asignaciones/${ofertaId}/aceptar`)
      .expect(200);
    const otra = await ctx
      .como(lejano)
      .post(`/v1/asignaciones/${ofertaId}/aceptar`)
      .expect(409);
    expect(otra.body.type).toBe('oferta-ya-respondida');

    const d = await ctx
      .como(donante)
      .get(`/v1/donaciones/${donacionId}`)
      .expect(200);
    expect(d.body.estado).toBe('ASIGNADA');
    expect(d.body.asignacion.voluntario.telefono).toBe('+573001112233');

    const oferta = await ctx
      .como(lejano)
      .get('/v1/asignaciones/ofertas')
      .expect(200);
    const aceptada = oferta.body.find((o: { id: string }) => o.id === ofertaId);
    expect(aceptada.contacto_telefono).toBe('+573001112233');
  });

  it('el voluntario arma la ruta: una recogida y la entrega en la sede', async () => {
    const r = await ctx
      .como(voluntarioAsignado)
      .post('/v1/rutas')
      .send({ donacion_ids: [donacionId] })
      .expect(201);
    rutaId = r.body.id;
    expect(r.body.estado).toBe('PLANIFICADA');
    expect(r.body.paradas.map((p: { tipo: string }) => p.tipo)).toEqual([
      'RECOGIDA',
      'ENTREGA',
    ]);
    expect(r.body.geometria.type).toBe('LineString');
    expect(r.body.proveedor_ruteo).toBeNull(); // sin llave de Google: fallback geodésico
    recogidaId = r.body.paradas[0].id;
    entregaId = r.body.paradas[1].id;

    // Otra persona no ve la ruta.
    await ctx.como(cercano).get(`/v1/rutas/${rutaId}`).expect(404);
  });

  it('iniciar la ruta pasa la donación a EN_RECOLECCION', async () => {
    await ctx
      .como(voluntarioAsignado)
      .post(`/v1/rutas/${rutaId}/iniciar`)
      .expect(200);
    const d = await ctx
      .como(donante)
      .get(`/v1/donaciones/${donacionId}`)
      .expect(200);
    expect(d.body.estado).toBe('EN_RECOLECCION');
    await ctx
      .como(voluntarioAsignado)
      .post(`/v1/paradas/${recogidaId}/llegada`)
      .send({ ubicacion: ZONA })
      .expect(200);
  });

  it('confirmar la recogida exige foto y GPS preciso (o confirmación manual)', async () => {
    const confirmacion = {
      peso_confirmado_kg: 9.5,
      ubicacion: ZONA,
      precision_m: 80,
      confirmada_en_dispositivo: new Date().toISOString(),
    };
    const sinFoto = await ctx
      .como(voluntarioAsignado)
      .post(`/v1/paradas/${recogidaId}/confirmar`)
      .send({ ...confirmacion, confirmacion_manual: true })
      .expect(422);
    expect(sinFoto.body.type).toBe('evidencia-requerida');

    const evidencia = {
      id: '3f1c2b9e-8d7a-4c6b-9e5f-1a2b3c4d5e6f',
      tipo: 'RECOGIDA',
      ruta: await ctx.ruta(voluntarioAsignado, 'EVIDENCIA'),
      parada_id: recogidaId,
      capturada_at: new Date().toISOString(),
      ubicacion: ZONA,
      precision_m: 80,
    };
    const e1 = await ctx
      .como(voluntarioAsignado)
      .post('/v1/evidencias')
      .send(evidencia)
      .expect(201);
    const e2 = await ctx
      .como(voluntarioAsignado)
      .post('/v1/evidencias')
      .send(evidencia)
      .expect(201);
    expect(e2.body.id).toBe(e1.body.id); // reenvío sin conexión: idempotente

    const imprecisa = await ctx
      .como(voluntarioAsignado)
      .post(`/v1/paradas/${recogidaId}/confirmar`)
      .send(confirmacion)
      .expect(422);
    expect(imprecisa.body.type).toBe('precision-insuficiente');

    const ok = await ctx
      .como(voluntarioAsignado)
      .post(`/v1/paradas/${recogidaId}/confirmar`)
      .send({ ...confirmacion, confirmacion_manual: true })
      .expect(200);
    expect(ok.body).toMatchObject({
      estado: 'COMPLETADA',
      confirmacion_manual: true,
      peso_confirmado_kg: 9.5,
    });

    // Reenvío de la misma confirmación: misma respuesta, sin efectos.
    await ctx
      .como(voluntarioAsignado)
      .post(`/v1/paradas/${recogidaId}/confirmar`)
      .send({ ...confirmacion, confirmacion_manual: true })
      .expect(200);

    const d = await ctx
      .como(donante)
      .get(`/v1/donaciones/${donacionId}`)
      .expect(200);
    expect(d.body).toMatchObject({
      estado: 'EN_TRANSITO',
      peso_recogido_kg: 9.5,
    });
  });

  it('el asesor confirma la entrega en la sede: la asignación y la ruta se completan', async () => {
    await ctx
      .como(voluntarioAsignado)
      .post('/v1/evidencias')
      .send({
        id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
        tipo: 'ENTREGA',
        ruta: await ctx.ruta(voluntarioAsignado, 'EVIDENCIA'),
        parada_id: entregaId,
        capturada_at: new Date().toISOString(),
      })
      .expect(201);
    await ctx
      .como(asesor)
      .post(`/v1/paradas/${entregaId}/confirmar`)
      .send({
        ubicacion: { lat: ZONA.lat + 0.01, lng: ZONA.lng + 0.01 },
        precision_m: 10,
        confirmada_en_dispositivo: new Date().toISOString(),
      })
      .expect(200);

    const ruta = await ctx
      .como(voluntarioAsignado)
      .get(`/v1/rutas/${rutaId}`)
      .expect(200);
    expect(ruta.body.estado).toBe('COMPLETADA');
    const d = await ctx
      .como(donante)
      .get(`/v1/donaciones/${donacionId}`)
      .expect(200);
    expect(d.body.estado).toBe('ENTREGADA');
    expect(d.body.asignacion.estado).toBe('COMPLETADA');
  });

  it('la recepción crea un lote por producto con su ENTRADA y la donación queda RECIBIDA', async () => {
    const r = await ctx
      .como(asesor)
      .post('/v1/recepciones')
      .send({ donacion_id: donacionId, estado: 'ACEPTADA' })
      .expect(201);
    expect(r.body).toMatchObject({ estado: 'ACEPTADA', peso_recibido_kg: 10 });
    expect(r.body.lotes).toHaveLength(2);
    loteId = r.body.lotes.find(
      (l: { tipo_alimento: { nombre: string } }) =>
        l.tipo_alimento.nombre === 'Arroz',
    ).id;

    await ctx
      .como(asesor)
      .post('/v1/recepciones')
      .send({ donacion_id: donacionId, estado: 'ACEPTADA' })
      .expect(409);

    const d = await ctx
      .como(donante)
      .get(`/v1/donaciones/${donacionId}`)
      .expect(200);
    expect(d.body).toMatchObject({ estado: 'RECIBIDA', peso_recibido_kg: 10 });

    const impacto = await ctx.como(donante).get('/v1/me/impacto').expect(200);
    expect(impacto.body.donante).toMatchObject({
      total_donaciones: 1,
      total_kg_donados: 10,
      donaciones_entregadas: 1,
    });
    const vol = await ctx
      .como(voluntarioAsignado)
      .get('/v1/me/impacto')
      .expect(200);
    expect(vol.body.voluntario).toMatchObject({
      total_entregas: 1,
      total_kg_transportados: 9.5,
      recolecciones_completadas: 1,
    });
  });

  it('el historial reconstruye toda la trazabilidad', async () => {
    const r = await ctx
      .como(donante)
      .get(`/v1/donaciones/${donacionId}/historial`)
      .expect(200);
    const estados = r.body
      .filter((h: { ambito: string }) => h.ambito === 'DONACION')
      .map((h: { estado_nuevo: string }) => h.estado_nuevo);
    expect(estados).toEqual([
      'BORRADOR',
      'PUBLICADA',
      'ASIGNADA',
      'EN_RECOLECCION',
      'EN_TRANSITO',
      'ENTREGADA',
      'RECIBIDA',
    ]);
    const asignaciones = r.body
      .filter((h: { ambito: string }) => h.ambito === 'ASIGNACION')
      .map((h: { estado_nuevo: string }) => h.estado_nuevo);
    expect(asignaciones).toEqual([
      'OFRECIDA',
      'RECHAZADA',
      'OFRECIDA',
      'ACEPTADA',
      'COMPLETADA',
    ]);
    const conUbicacion = r.body.find(
      (h: { ambito: string; estado_nuevo: string }) =>
        h.ambito === 'PARADA' && h.estado_nuevo === 'COMPLETADA',
    );
    expect(conUbicacion.lat).toBeCloseTo(ZONA.lat, 5);
  });

  it('calificación mutua, una vez por parte', async () => {
    const asignacionId = ofertaId;
    await ctx
      .como(donante)
      .post(`/v1/asignaciones/${asignacionId}/calificacion`)
      .send({ puntaje: 5, comentario: 'Puntual' })
      .expect(201);
    const repetida = await ctx
      .como(donante)
      .post(`/v1/asignaciones/${asignacionId}/calificacion`)
      .send({ puntaje: 4 })
      .expect(409);
    expect(repetida.body.type).toBe('ya-calificada');
    await ctx
      .como(voluntarioAsignado)
      .post(`/v1/asignaciones/${asignacionId}/calificacion`)
      .send({ puntaje: 4 })
      .expect(201);
    const vol = await ctx.como(voluntarioAsignado).get('/v1/me').expect(200);
    expect(vol.body.voluntario.calificacion_promedio).toBe(5);
    const don = await ctx.como(donante).get('/v1/me').expect(200);
    expect(don.body.donante.calificacion_promedio).toBe(4);
  });

  it('distribución FEFO: reserva, anula y confirma con el libro mayor consistente', async () => {
    const pedido = {
      tipo_destino_id: cat.destino('COMEDOR'),
      nombre_destino: 'Comedor comunitario El Paraíso',
      numero_beneficiarios: 40,
      lineas: [
        {
          tipo_alimento_id: cat.tipo('ARROZ'),
          unidad_medida_id: 1,
          cantidad: 4,
        },
      ],
    };
    const d1 = await ctx
      .como(asesor)
      .post('/v1/distribuciones')
      .send(pedido)
      .expect(201);
    expect(d1.body.distribucion_detalle[0]).toMatchObject({
      cantidad: 4,
      peso_kg: 4,
    });
    let lote = await ctx
      .como(asesor)
      .get(`/v1/inventario/lotes/${loteId}`)
      .expect(200);
    expect(lote.body.cantidad_disponible).toBe(2);

    await ctx
      .como(asesor)
      .post(`/v1/distribuciones/${d1.body.id}/anular`)
      .expect(200);
    lote = await ctx
      .como(asesor)
      .get(`/v1/inventario/lotes/${loteId}`)
      .expect(200);
    expect(lote.body.cantidad_disponible).toBe(6);

    const d2 = await ctx
      .como(asesor)
      .post('/v1/distribuciones')
      .send(pedido)
      .expect(201);
    await ctx
      .como(asesor)
      .post(`/v1/distribuciones/${d2.body.id}/confirmar`)
      .expect(200);
    await ctx
      .como(asesor)
      .post(`/v1/distribuciones/${d2.body.id}/anular`)
      .expect(409);

    const exceso = await ctx
      .como(asesor)
      .post('/v1/distribuciones')
      .send({ ...pedido, lineas: [{ ...pedido.lineas[0], cantidad: 500 }] })
      .expect(409);
    expect(exceso.body.type).toBe('stock-insuficiente');

    lote = await ctx
      .como(asesor)
      .get(`/v1/inventario/lotes/${loteId}`)
      .expect(200);
    const suma = lote.body.movimiento_inventario.reduce(
      (s: number, m: { cantidad: number }) => s + m.cantidad,
      0,
    );
    expect(suma).toBeCloseTo(lote.body.cantidad_disponible, 2);
    expect(
      lote.body.movimiento_inventario.map((m: { tipo: string }) => m.tipo),
    ).toEqual(['ENTRADA', 'SALIDA', 'DEVOLUCION', 'SALIDA']);
  });

  it('las notificaciones encoladas salen por push a los dispositivos registrados', async () => {
    await ctx
      .como(donante)
      .post('/v1/me/dispositivos')
      .send({
        token_push: 'ExponentPushToken[donante-prueba]',
        plataforma: 'ANDROID',
      })
      .expect(201);
    const envio = ctx.app.get(EnvioNotificacionesService);
    const resultado = await envio.procesarPendientes();
    expect(resultado.enviadas).toBeGreaterThan(0);
    const alDonante = ctx.push.enviados.filter(
      (m) => m.token === 'ExponentPushToken[donante-prueba]',
    );
    expect(alDonante.map((m) => m.titulo)).toEqual(
      expect.arrayContaining([
        'Tu donación fue aceptada',
        'Tu donación fue recogida',
        'Tu donación fue recibida',
      ]),
    );

    const bandeja = await ctx
      .como(donante)
      .get('/v1/me/notificaciones')
      .expect(200);
    expect(bandeja.body.no_leidas).toBeGreaterThan(0);
    await ctx
      .como(donante)
      .post('/v1/me/notificaciones/leer-todas')
      .expect(200);
    const leida = await ctx
      .como(donante)
      .get('/v1/me/notificaciones')
      .expect(200);
    expect(leida.body.no_leidas).toBe(0);
  });

  it('los indicadores reflejan el ciclo', async () => {
    const r = await ctx.como(admin).get('/v1/kpis/resumen').expect(200);
    expect(r.body.donaciones.kg_recuperados).toBeGreaterThanOrEqual(10);
    expect(r.body.asignacion.tasa_aceptacion).toBeGreaterThan(0);
    expect(r.body.inventario.kg_distribuidos).toBeGreaterThanOrEqual(4);
  });
});
