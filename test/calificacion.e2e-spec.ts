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

/** F-12: calificación con aspectos del catálogo e idempotente por usuario. */
describe('Calificación con aspectos', () => {
  // Zona propia, lejos de las otras suites: sus voluntarios no son candidatos aquí.
  const ZONA = { lat: 3.45, lng: -76.53 };
  let ctx: ContextoPruebas;
  let admin: Cuenta;
  let donante: Cuenta;
  let voluntario: Cuenta & { voluntarioId: string };
  let cat: Catalogos;
  let donacionId: string;
  let asignacionId: string;
  let calificacionId: string;

  const calificar = (cuenta: Cuenta, cuerpo: Record<string, unknown>) =>
    ctx
      .como(cuenta)
      .post(`/v1/asignaciones/${asignacionId}/calificacion`)
      .send(cuerpo);

  beforeAll(async () => {
    ctx = await ContextoPruebas.crear();
    admin = await ctx.admin();
    donante = await ctx.cuenta({ nombres: 'Donante Calificador' });
    cat = await catalogos(ctx, donante);
    await prepararBanco(ctx, admin, ZONA);
    voluntario = await ctx.voluntario(admin, {
      lat: ZONA.lat + 0.002,
      lng: ZONA.lng + 0.002,
    });

    const borrador = await ctx
      .como(donante)
      .post('/v1/donaciones')
      .send({
        ...ventana(4),
        direccion_recogida: 'Avenida 6 # 15-20',
        ubicacion_recogida: ZONA,
        items: [
          {
            tipo_alimento_id: cat.tipo('ARROZ'),
            cantidad: 5,
            peso_estimado_kg: 5,
          },
        ],
      })
      .expect(201);
    donacionId = borrador.body.id;
    await ctx
      .como(donante)
      .post(`/v1/donaciones/${donacionId}/publicar`)
      .expect(200);
    const { rows } = await ctx.sql.query<{ id: string }>(
      `SELECT id FROM asignacion WHERE donacion_id = $1 AND estado = 'OFRECIDA'`,
      [donacionId],
    );
    asignacionId = rows[0].id;
    await ctx
      .como(voluntario)
      .post(`/v1/asignaciones/${asignacionId}/aceptar`)
      .expect(200);
    // Atajo: el recorrido en calle ya lo cubre flujo-completo.
    await ctx.sql.query(
      `UPDATE asignacion SET estado = 'COMPLETADA', finalizada_at = now() WHERE id = $1`,
      [asignacionId],
    );
  });

  afterAll(async () => {
    await ctx.cerrar();
  });

  it('el catálogo lista los aspectos con que el donante califica al voluntario', async () => {
    const r = await ctx
      .como(donante)
      .get(
        '/v1/catalogos?incluir=aspectos_calificacion&rol_calificado=VOLUNTARIO',
      )
      .expect(200);
    expect(Object.keys(r.body)).toEqual(['aspectos_calificacion']);
    expect(
      r.body.aspectos_calificacion.map((a: { codigo: string }) => a.codigo),
    ).toEqual([
      'PUNTUALIDAD',
      'AMABILIDAD',
      'CUIDADO',
      'COMUNICACION',
      'PRESENTACION',
    ]);
    expect(r.body.aspectos_calificacion[2]).toEqual({
      id: expect.any(Number),
      rol_calificado: 'VOLUNTARIO',
      codigo: 'CUIDADO',
      nombre: 'Cuidado de los alimentos',
    });
  });

  it('antes de calificar, el detalle indica calificada_por_mi en false', async () => {
    const r = await ctx
      .como(donante)
      .get(`/v1/donaciones/${donacionId}`)
      .expect(200);
    expect(r.body.asignacion.calificada_por_mi).toBe(false);
  });

  it('un aspecto fuera del catálogo responde 422 y no guarda nada', async () => {
    const r = await calificar(donante, {
      puntaje: 5,
      aspectos: ['PUNTUALIDAD', 'INVENTADO'],
    }).expect(422);
    expect(r.body.type).toBe('aspecto-invalido');
    expect(r.body.codigos_invalidos).toEqual(['INVENTADO']);
    const { rows } = await ctx.sql.query(
      'SELECT 1 FROM calificacion WHERE asignacion_id = $1',
      [asignacionId],
    );
    expect(rows).toHaveLength(0);
  });

  it('un aspecto de otro rol también es inválido (el voluntario califica al donante)', async () => {
    const r = await calificar(voluntario, {
      puntaje: 4,
      aspectos: ['PUNTUALIDAD'],
    }).expect(422);
    expect(r.body.type).toBe('aspecto-invalido');
  });

  it('el donante califica con aspectos: 201 con los aspectos guardados', async () => {
    const r = await calificar(donante, {
      puntaje: 5,
      comentario: 'Muy cuidadoso',
      aspectos: ['CUIDADO', 'PUNTUALIDAD'],
    }).expect(201);
    calificacionId = r.body.id;
    expect(r.body).toEqual({
      id: expect.any(String),
      puntaje: 5,
      comentario: 'Muy cuidadoso',
      aspectos: [
        { codigo: 'PUNTUALIDAD', nombre: 'Puntualidad' },
        { codigo: 'CUIDADO', nombre: 'Cuidado de los alimentos' },
      ],
      created_at: expect.any(String),
    });
  });

  it('repetir la calificación devuelve 200 con la original, sin duplicar', async () => {
    const r = await calificar(donante, {
      puntaje: 1,
      aspectos: ['AMABILIDAD'],
    }).expect(200);
    expect(r.body.id).toBe(calificacionId);
    expect(r.body.puntaje).toBe(5);
    expect(r.body.aspectos.map((a: { codigo: string }) => a.codigo)).toEqual([
      'PUNTUALIDAD',
      'CUIDADO',
    ]);
    const { rows } = await ctx.sql.query(
      'SELECT 1 FROM calificacion WHERE asignacion_id = $1',
      [asignacionId],
    );
    expect(rows).toHaveLength(1);
    const vol = await ctx.como(voluntario).get('/v1/me').expect(200);
    expect(vol.body.voluntario.calificacion_promedio).toBe(5);
  });

  it('después de calificar, el detalle indica calificada_por_mi solo a quien calificó', async () => {
    const delDonante = await ctx
      .como(donante)
      .get(`/v1/donaciones/${donacionId}`)
      .expect(200);
    expect(delDonante.body.asignacion.calificada_por_mi).toBe(true);
    const delVoluntario = await ctx
      .como(voluntario)
      .get(`/v1/donaciones/${donacionId}`)
      .expect(200);
    expect(delVoluntario.body.asignacion.calificada_por_mi).toBe(false);
  });

  it('el voluntario califica al donante sin aspectos', async () => {
    const r = await calificar(voluntario, { puntaje: 4 }).expect(201);
    expect(r.body.aspectos).toEqual([]);
  });
});
