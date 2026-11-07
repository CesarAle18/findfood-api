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

interface Aviso {
  usuario_id: string;
  codigo: string;
  canal: string;
  donacion_id: string | null;
  asignacion_id: string | null;
  data: Record<string, unknown>;
  cuerpo: string;
}

/**
 * Avisos a los afectados por lo que hacen otros (N1–N7 de sincronizacion-tiempo-real): cada
 * hecho deja una sola fila en la bandeja de cada afectado (la misma fila es la cola del push) y
 * nunca avisa a quien lo provoca. Zona propia: los dos voluntarios de cada caso reciben todas
 * las ofertas.
 */
describe('Avisos a los afectados', () => {
  const ZONA = { lat: 10.4, lng: -75.5 };
  let ctx: ContextoPruebas;
  let admin: Cuenta;
  let asesor: Cuenta;
  let cat: Catalogos;
  let v1: Voluntario;
  let v2: Voluntario;

  const COLUMNAS = `n.usuario_id, t.codigo, n.canal::text AS canal, n.donacion_id,
                    n.asignacion_id, n.data, n.cuerpo
               FROM notificacion n JOIN tipo_notificacion t ON t.id = n.tipo_notificacion_id`;

  /** Avisos de la donación con esos códigos, en orden. */
  async function avisos(donacionId: string, codigos: string[]) {
    const { rows } = await ctx.sql.query<Aviso>(
      `SELECT ${COLUMNAS}
        WHERE n.donacion_id = $1 AND t.codigo = ANY($2::text[])
        ORDER BY n.created_at, t.codigo, n.usuario_id`,
      [donacionId, codigos],
    );
    return rows;
  }

  /** Avisos que nombran la incidencia, en orden. */
  async function avisosIncidencia(incidenciaId: string) {
    const { rows } = await ctx.sql.query<Aviso>(
      `SELECT ${COLUMNAS}
        WHERE n.data->>'incidencia_id' = $1
        ORDER BY n.created_at, t.codigo, n.usuario_id`,
      [incidenciaId],
    );
    return rows;
  }

  /** Todo lo que recibió `usuarioId` sobre la donación, en orden. */
  async function codigos(usuarioId: string, donacionId: string) {
    const { rows } = await ctx.sql.query<{ codigo: string }>(
      `SELECT t.codigo
         FROM notificacion n JOIN tipo_notificacion t ON t.id = n.tipo_notificacion_id
        WHERE n.usuario_id = $1 AND n.donacion_id = $2
        ORDER BY n.created_at, t.codigo`,
      [usuarioId, donacionId],
    );
    return rows.map((r) => r.codigo);
  }

  /**
   * Destinatarios ordenados por id. Prisma pone created_at en cada sentencia, no por
   * transacción: dentro de un mismo hecho el orden es el de inserción.
   */
  const destinatarios = (lista: Aviso[]) =>
    lista.map((a) => a.usuario_id).sort();

  /** El personal ACTIVO (ADMIN y ASESOR_BANCO), incluido el que crearon otras suites. */
  async function personal(): Promise<string[]> {
    const { rows } = await ctx.sql.query<{ id: string }>(
      `SELECT DISTINCT u.id
         FROM usuario u
         JOIN usuario_rol ur ON ur.usuario_id = u.id AND ur.activo
         JOIN rol r ON r.id = ur.rol_id
        WHERE u.estado = 'ACTIVO' AND u.deleted_at IS NULL
          AND r.codigo IN ('ADMIN', 'ASESOR_BANCO')`,
    );
    return rows.map((r) => r.id).sort();
  }

  /** Crea y publica una donación de un donante nuevo; los dos voluntarios reciben oferta. */
  async function publicada() {
    const donante = await ctx.cuenta({ nombres: 'Donante' });
    const d = await ctx
      .como(donante)
      .post('/v1/donaciones')
      .send({
        ...ventana(4),
        direccion_recogida: 'Calle 30 # 17-25',
        ubicacion_recogida: { lat: ZONA.lat + 0.005, lng: ZONA.lng + 0.005 },
        items: [
          {
            tipo_alimento_id: cat.tipo('ARROZ'),
            cantidad: 10,
            peso_estimado_kg: 10,
          },
        ],
      })
      .expect(201);
    const id = d.body.id as string;
    await ctx.como(donante).post(`/v1/donaciones/${id}/publicar`).expect(200);
    const { rows } = await ctx.sql.query<{ id: string; voluntario_id: string }>(
      `SELECT id, voluntario_id FROM asignacion
        WHERE donacion_id = $1 AND estado = 'OFRECIDA'`,
      [id],
    );
    expect(rows.map((a) => a.voluntario_id).sort()).toEqual(
      [v1.voluntarioId, v2.voluntarioId].sort(),
    );
    const oferta = (v: Voluntario) =>
      rows.find((a) => a.voluntario_id === v.voluntarioId)!.id;
    return { id, donante, oferta };
  }

  /** Publica y la acepta v1: la recogida entra a su ruta dinámica (EN_CURSO). */
  async function aceptada() {
    const p = await publicada();
    const r = await ctx
      .como(v1)
      .post(`/v1/asignaciones/${p.oferta(v1)}/aceptar`)
      .expect(200);
    return {
      ...p,
      asignacionId: p.oferta(v1),
      rutaId: r.body.ruta.id as string,
    };
  }

  async function incidenciaDe(
    columna: 'donacion_id' | 'parada_id',
    id: string,
  ) {
    const { rows } = await ctx.sql.query<{ id: string }>(
      `SELECT id FROM incidencia WHERE ${columna} = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    return rows[0].id;
  }

  beforeAll(async () => {
    ctx = await ContextoPruebas.crear();
    admin = await ctx.admin();
    asesor = await ctx.asesor();
    cat = await catalogos(ctx, admin);
    await prepararBanco(ctx, admin, ZONA);
  });

  // Una ruta dinámica sigue EN_CURSO hasta la entrega: cada caso usa voluntarios nuevos
  // y apaga a los anteriores para que no compitan por las ofertas.
  beforeEach(async () => {
    await ctx.sql.query(
      `UPDATE voluntario SET disponible = false
        WHERE ST_DWithin(ubicacion_base, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, 60000)`,
      [ZONA.lat, ZONA.lng],
    );
    v1 = await ctx.voluntario(admin, ZONA);
    v2 = await ctx.voluntario(admin, {
      lat: ZONA.lat + 0.01,
      lng: ZONA.lng + 0.01,
    });
  });

  afterAll(async () => {
    await ctx.cerrar();
  });

  it('N1: el ADMIN cancela una donación ajena y su donante recibe el motivo; quien cancela la suya no', async () => {
    const p = await publicada();
    await ctx
      .como(admin)
      .post(`/v1/donaciones/${p.id}/cancelar`)
      .send({
        motivo_id: cat.motivo('CANCELACION_DONACION', 'CANCELADA_POR_BANCO'),
        observacion: 'Sin cupo en la bodega',
      })
      .expect(200);
    expect(await avisos(p.id, ['DONACION_CANCELADA_BANCO'])).toEqual([
      {
        usuario_id: p.donante.id,
        codigo: 'DONACION_CANCELADA_BANCO',
        canal: 'PUSH',
        donacion_id: p.id,
        asignacion_id: null,
        data: { tipo: 'DONACION_CANCELADA_BANCO', donacion_id: p.id },
        cuerpo: expect.stringContaining('Motivo: Sin cupo en la bodega'),
      },
    ]);
    // Las ofertas vivas ya avisaban a su voluntario (DONACION_CANCELADA).
    expect(destinatarios(await avisos(p.id, ['DONACION_CANCELADA']))).toEqual(
      [v1.id, v2.id].sort(),
    );

    const propia = await publicada();
    await ctx
      .como(propia.donante)
      .post(`/v1/donaciones/${propia.id}/cancelar`)
      .send({
        motivo_id: cat.motivo('CANCELACION_DONACION', 'CAMBIO_DE_PLANES'),
      })
      .expect(200);
    expect(await codigos(propia.donante.id, propia.id)).toEqual([]);
  });

  it('N4: al aceptar uno, cada voluntario que perdió la oferta recibe un aviso con su asignación', async () => {
    const p = await publicada();
    await ctx
      .como(v1)
      .post(`/v1/asignaciones/${p.oferta(v1)}/aceptar`)
      .expect(200);
    expect(await avisos(p.id, ['ASIGNACION_TOMADA'])).toEqual([
      expect.objectContaining({
        usuario_id: v2.id,
        canal: 'PUSH',
        asignacion_id: p.oferta(v2),
        data: {
          tipo: 'ASIGNACION_TOMADA',
          donacion_id: p.id,
          asignacion_id: p.oferta(v2),
        },
      }),
    ]);
    // Ni el ganador ni un DONACION_CANCELADA de más.
    expect(await codigos(v1.id, p.id)).toEqual(['ASIGNACION_OFRECIDA']);
    expect(await codigos(v2.id, p.id)).toEqual([
      'ASIGNACION_OFRECIDA',
      'ASIGNACION_TOMADA',
    ]);
  });

  it('N2: reasignar o cancelar la ruta de la flota avisa al donante que se busca otro voluntario', async () => {
    const p = await aceptada();
    await ctx
      .como(asesor)
      .post(`/v1/donaciones/${p.id}/reasignar`)
      .send({ observacion: 'El voluntario no responde' })
      .expect(200);
    expect(await avisos(p.id, ['DONACION_REPUBLICADA'])).toEqual([
      expect.objectContaining({
        usuario_id: p.donante.id,
        canal: 'PUSH',
        asignacion_id: null,
        data: { tipo: 'DONACION_REPUBLICADA', donacion_id: p.id },
      }),
    ]);
    expect(await codigos(p.donante.id, p.id)).toEqual([
      'ASIGNACION_ACEPTADA',
      'DONACION_REPUBLICADA',
    ]);

    // La flota del banco: cancelar su ruta sin iniciar vuelve a publicar la donación.
    const f = await publicada();
    const flota = await ctx
      .como(asesor)
      .post('/v1/rutas')
      .send({ donacion_ids: [f.id], origen: ZONA })
      .expect(201);
    await ctx
      .como(asesor)
      .post(`/v1/rutas/${flota.body.id}/cancelar`)
      .expect(200);
    expect(await codigos(f.donante.id, f.id)).toEqual([
      'ASIGNACION_ACEPTADA',
      'DONACION_REPUBLICADA',
    ]);
  });

  it('N2: abandonar con margen avisa al donante y no abre incidencia', async () => {
    const p = await aceptada();
    const r = await ctx
      .como(v1)
      .post(`/v1/asignaciones/${p.asignacionId}/abandonar`)
      .send({ motivo_id: cat.motivo('ABANDONO_ASIGNACION', 'VEHICULO') })
      .expect(200);
    expect(r.body.donacion_republicada).toBe(true);
    expect(await codigos(p.donante.id, p.id)).toEqual([
      'ASIGNACION_ACEPTADA',
      'DONACION_REPUBLICADA',
    ]);
    const { rows } = await ctx.sql.query(
      'SELECT 1 FROM incidencia WHERE donacion_id = $1',
      [p.id],
    );
    expect(rows).toEqual([]);
  });

  it('N2/N5: abandonar sin margen solo expira (DONACION_EXPIRADA) y la incidencia avisa al personal', async () => {
    const p = await aceptada();
    await ctx.sql.query(
      `UPDATE donacion SET ventana_recogida_inicio = now() - interval '1 hour',
                           ventana_recogida_fin = now() + interval '5 minutes' WHERE id = $1`,
      [p.id],
    );
    const r = await ctx
      .como(v1)
      .post(`/v1/asignaciones/${p.asignacionId}/abandonar`)
      .send({ motivo_id: cat.motivo('ABANDONO_ASIGNACION', 'VEHICULO') })
      .expect(200);
    expect(r.body.donacion_republicada).toBe(false);
    expect(await codigos(p.donante.id, p.id)).toEqual([
      'ASIGNACION_ACEPTADA',
      'DONACION_EXPIRADA',
    ]);

    const incidenciaId = await incidenciaDe('donacion_id', p.id);
    const reportada = await avisosIncidencia(incidenciaId);
    expect(destinatarios(reportada)).toEqual(await personal());
    expect(reportada[0]).toMatchObject({
      codigo: 'INCIDENCIA_REPORTADA',
      canal: 'IN_APP',
      donacion_id: p.id,
      asignacion_id: p.asignacionId,
      data: {
        tipo: 'INCIDENCIA_REPORTADA',
        incidencia_id: incidenciaId,
        donacion_id: p.id,
        asignacion_id: p.asignacionId,
      },
    });
  });

  it('N3/N5/N6: la recogida fallida avisa al donante y al personal; revisar y resolver, a quien reportó', async () => {
    const p = await aceptada();
    const { rows: paradas } = await ctx.sql.query<{ id: string }>(
      `SELECT id FROM parada_ruta
        WHERE ruta_id = $1 AND donacion_id = $2 AND tipo = 'RECOGIDA'`,
      [p.rutaId, p.id],
    );
    await ctx
      .como(v1)
      .post(`/v1/paradas/${paradas[0].id}/fallida`)
      .send({
        tipo_incidencia_id: cat.tipoIncidencia('DONANTE_AUSENTE'),
        descripcion: 'Nadie abrió en 20 minutos',
      })
      .expect(200);
    expect(await avisos(p.id, ['RECOGIDA_FALLIDA'])).toEqual([
      {
        usuario_id: p.donante.id,
        codigo: 'RECOGIDA_FALLIDA',
        canal: 'PUSH',
        donacion_id: p.id,
        asignacion_id: null,
        data: { tipo: 'RECOGIDA_FALLIDA', donacion_id: p.id },
        cuerpo: expect.stringContaining('El banco de alimentos revisará'),
      },
    ]);

    const incidenciaId = await incidenciaDe('parada_id', paradas[0].id);
    const reportada = await avisosIncidencia(incidenciaId);
    expect(destinatarios(reportada)).toEqual(await personal());
    expect(new Set(reportada.map((a) => a.codigo))).toEqual(
      new Set(['INCIDENCIA_REPORTADA']),
    );
    expect(reportada[0].cuerpo).toContain('Donante no estaba en el punto');

    await ctx
      .como(asesor)
      .post(`/v1/incidencias/${incidenciaId}/revisar`)
      .expect(200);
    await ctx
      .como(admin)
      .post(`/v1/incidencias/${incidenciaId}/resolver`)
      .send({ resolucion: 'Se reprograma con el donante' })
      .expect(200);
    const alReportante = (await avisosIncidencia(incidenciaId)).filter(
      (a) => a.usuario_id === v1.id,
    );
    expect(alReportante).toEqual([
      expect.objectContaining({
        codigo: 'INCIDENCIA_EN_REVISION',
        canal: 'PUSH',
        donacion_id: p.id,
        data: {
          tipo: 'INCIDENCIA_EN_REVISION',
          incidencia_id: incidenciaId,
          donacion_id: p.id,
        },
      }),
      expect.objectContaining({
        codigo: 'INCIDENCIA_RESUELTA',
        cuerpo: expect.stringContaining('Se reprograma con el donante'),
      }),
    ]);
  });

  it('N5/N6: el personal que reporta no se avisa a sí mismo', async () => {
    const p = await publicada();
    const r = await ctx
      .como(asesor)
      .post('/v1/incidencias')
      .send({
        tipo_incidencia_id: cat.tipoIncidencia('OTRO'),
        descripcion: 'Revisión preventiva del punto',
        donacion_id: p.id,
      })
      .expect(201);
    const incidenciaId = r.body.id as string;
    const reportada = await avisosIncidencia(incidenciaId);
    expect(destinatarios(reportada)).toEqual(
      (await personal()).filter((id) => id !== asesor.id),
    );

    // Quien revisa es quien reportó: nadie más se entera de su propia toma.
    await ctx
      .como(asesor)
      .post(`/v1/incidencias/${incidenciaId}/revisar`)
      .expect(200);
    await ctx
      .como(admin)
      .post(`/v1/incidencias/${incidenciaId}/resolver`)
      .send({ resolucion: 'Sin novedad' })
      .expect(200);
    expect(
      (await avisosIncidencia(incidenciaId))
        .filter((a) => a.codigo !== 'INCIDENCIA_REPORTADA')
        .map((a) => [a.usuario_id, a.codigo]),
    ).toEqual([[asesor.id, 'INCIDENCIA_RESUELTA']]);
  });

  it('N7: el personal no puede cancelar la ruta de un voluntario, así que no hay a quién avisar', async () => {
    const p = await aceptada();
    const r = await ctx
      .como(admin)
      .post(`/v1/rutas/${p.rutaId}/cancelar`)
      .expect(403);
    expect(r.body.type).toBe('no-ejecutor');
  });
});
