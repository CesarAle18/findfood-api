import {
  RUTA_MAX_ACTIVA_HORAS,
  RuteoService,
} from '../src/modulos/ruteo/ruteo.service';
import {
  type Cuenta,
  ContextoPruebas,
  ventana,
} from './utilidades/app-de-pruebas';
import { catalogos, prepararBanco } from './utilidades/escenario';

/** Regla RUTA_MAX_ACTIVA_HORAS: una ruta activa por más de 24 h se cancela sola. */
describe('Rutas vencidas', () => {
  // Zona propia: el único voluntario disponible aquí recibe todas las ofertas.
  const ZONA = { lat: 7.9, lng: -72.5 };
  const cerca = (d: number) => ({ lat: ZONA.lat + d, lng: ZONA.lng + d });
  let ctx: ContextoPruebas;
  let ruteo: RuteoService;
  let vol: Cuenta & { voluntarioId: string };
  let donante: Cuenta;
  let rutaId: string;
  const donaciones: string[] = [];

  async function estado(tabla: 'donacion' | 'ruta', id: string) {
    const { rows } = await ctx.sql.query<{ estado: string }>(
      `SELECT estado::text FROM ${tabla} WHERE id = $1`,
      [id],
    );
    return rows[0].estado;
  }

  beforeAll(async () => {
    ctx = await ContextoPruebas.crear();
    ruteo = ctx.app.get(RuteoService);
    const admin = await ctx.admin();
    const cat = await catalogos(ctx, admin);
    await prepararBanco(ctx, admin, ZONA);
    vol = await ctx.voluntario(admin, cerca(0.001));
    donante = await ctx.cuenta({ nombres: 'Donante rutas vencidas' });

    // Dos recogidas aceptadas: una sola ruta EN_CURSO con dos paradas y la entrega.
    for (const d of [0.01, 0.02]) {
      const r = await ctx
        .como(donante)
        .post('/v1/donaciones')
        .send({
          ...ventana(48),
          direccion_recogida: 'Calle 10 # 0-10',
          ubicacion_recogida: cerca(d),
          items: [
            { tipo_alimento_id: cat.tipo('ARROZ'), cantidad: 5, peso_estimado_kg: 5 },
          ],
        })
        .expect(201);
      await ctx
        .como(donante)
        .post(`/v1/donaciones/${r.body.id}/publicar`)
        .expect(200);
      const { rows } = await ctx.sql.query<{ id: string }>(
        `SELECT id FROM asignacion WHERE donacion_id = $1 AND estado = 'OFRECIDA'`,
        [r.body.id],
      );
      const aceptada = await ctx
        .como(vol)
        .post(`/v1/asignaciones/${rows[0].id}/aceptar`)
        .expect(200);
      rutaId = aceptada.body.ruta.id;
      donaciones.push(r.body.id);
    }
  });

  afterAll(async () => {
    await ctx.cerrar();
  });

  it(`no toca una ruta con menos de ${RUTA_MAX_ACTIVA_HORAS} h`, async () => {
    await ruteo.cancelarRutasVencidas();
    expect(await estado('ruta', rutaId)).toBe('EN_CURSO');
  });

  it('cancela la ruta vencida: lo pendiente expira y lo ya recogido queda para el personal', async () => {
    const [recogida, pendiente] = donaciones;
    // La primera recogida ya se hizo (la comida va en el vehículo).
    await ctx.sql.query(
      `UPDATE parada_ruta SET estado = 'COMPLETADA', confirmada_at = now()
        WHERE ruta_id = $1 AND donacion_id = $2`,
      [rutaId, recogida],
    );
    await ctx.sql.query(
      `UPDATE ruta SET created_at = now() - make_interval(hours => $2) WHERE id = $1`,
      [rutaId, RUTA_MAX_ACTIVA_HORAS + 1],
    );

    expect(await ruteo.cancelarRutasVencidas()).toBeGreaterThanOrEqual(1);

    expect(await estado('ruta', rutaId)).toBe('CANCELADA');
    const { rows: paradas } = await ctx.sql.query<{
      tipo: string;
      donacion_id: string | null;
      estado: string;
    }>(
      `SELECT tipo::text, donacion_id, estado::text FROM parada_ruta WHERE ruta_id = $1`,
      [rutaId],
    );
    const parada = (donacionId: string | null) =>
      paradas.find((p) => p.donacion_id === donacionId)!.estado;
    expect(parada(recogida)).toBe('COMPLETADA');
    expect(parada(pendiente)).toBe('OMITIDA');
    expect(paradas.find((p) => p.tipo === 'ENTREGA')!.estado).toBe('OMITIDA');

    // Lo pendiente expira y su asignación se cancela (no cuenta como abandono).
    expect(await estado('donacion', pendiente)).toBe('EXPIRADA');
    expect(await estado('donacion', recogida)).toBe('EN_RECOLECCION');
    const { rows: asignaciones } = await ctx.sql.query<{
      donacion_id: string;
      estado: string;
    }>(
      `SELECT donacion_id, estado::text FROM asignacion
        WHERE donacion_id = ANY($1) AND estado <> 'OFRECIDA'`,
      [donaciones],
    );
    expect(asignaciones).toEqual(
      expect.arrayContaining([
        { donacion_id: pendiente, estado: 'CANCELADA' },
        { donacion_id: recogida, estado: 'ACEPTADA' },
      ]),
    );

    // Avisos: el donante (expiró) y el voluntario (ya no debe recoger).
    const { rows: avisos } = await ctx.sql.query<{
      usuario_id: string;
      codigo: string;
    }>(
      `SELECT n.usuario_id, t.codigo FROM notificacion n
         JOIN tipo_notificacion t ON t.id = n.tipo_notificacion_id
        WHERE n.donacion_id = $1`,
      [pendiente],
    );
    expect(avisos).toEqual(
      expect.arrayContaining([
        { usuario_id: donante.id, codigo: 'DONACION_EXPIRADA' },
        { usuario_id: vol.id, codigo: 'DONACION_CANCELADA' },
      ]),
    );

    // El historial deja constancia de la regla y de lo que el personal debe resolver.
    const { rows: historial } = await ctx.sql.query<{
      estado_anterior: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT estado_anterior, metadata FROM historial_estado
        WHERE ruta_id = $1 AND estado_nuevo = 'CANCELADA'`,
      [rutaId],
    );
    expect(historial).toHaveLength(1);
    expect(historial[0]).toMatchObject({
      estado_anterior: 'EN_CURSO',
      metadata: {
        regla: 'RUTA_MAX_ACTIVA_HORAS',
        horas: RUTA_MAX_ACTIVA_HORAS,
        donaciones_expiradas: [pendiente],
        recogidas_sin_entregar: [recogida],
      },
    });
  });

  it('es idempotente: una ruta ya cancelada no se vuelve a procesar', async () => {
    const { rows } = await ctx.sql.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM historial_estado
        WHERE ruta_id = $1 AND estado_nuevo = 'CANCELADA'`,
      [rutaId],
    );
    await ruteo.cancelarRutasVencidas();
    const { rows: despues } = await ctx.sql.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM historial_estado
        WHERE ruta_id = $1 AND estado_nuevo = 'CANCELADA'`,
      [rutaId],
    );
    expect(despues[0].n).toBe(rows[0].n);
  });
});
