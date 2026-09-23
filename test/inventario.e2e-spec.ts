import { LotesService } from '../src/modulos/inventario/lotes.service';
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

/** Inventario (§10): FEFO, libro mayor, ajustes, alertas y recepción parcial. */
describe('Inventario', () => {
  const ZONA = { lat: 6.3, lng: -75.5 };
  let ctx: ContextoPruebas;
  let admin: Cuenta;
  let asesor: Cuenta;
  let cat: Catalogos;
  let sedes: { seco: string; refrigerado: string };
  let tipoId: number;
  const lotes: Record<'A' | 'B' | 'C' | 'D', string> = {
    A: '',
    B: '',
    C: '',
    D: '',
  };

  async function loteDePrueba(
    cantidad: number,
    vence: string | null,
    diasIngreso = 0,
  ): Promise<string> {
    const { rows } = await ctx.sql.query<{ id: string }>(
      `WITH l AS (
         INSERT INTO lote_inventario
           (codigo_lote, banco_id, almacen_id, tipo_alimento_id, unidad_medida_id,
            cantidad_inicial, cantidad_disponible, peso_inicial_kg, peso_disponible_kg,
            fecha_vencimiento, fecha_ingreso, created_by)
         SELECT 'T-' || substr(md5(random()::text), 1, 10), a.banco_id, a.id, $1, 1,
                $2, $2, $2, $2, $3::date, now() - make_interval(days => $4), $5
           FROM almacen a WHERE a.id = $6
         RETURNING id, cantidad_inicial)
       INSERT INTO movimiento_inventario (lote_id, tipo, cantidad, peso_kg, saldo_cantidad, usuario_id)
       SELECT id, 'ENTRADA', cantidad_inicial, cantidad_inicial, cantidad_inicial, $5 FROM l
       RETURNING lote_id AS id`,
      [tipoId, cantidad, vence, diasIngreso, asesor.id, sedes.seco],
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    ctx = await ContextoPruebas.crear();
    admin = await ctx.admin();
    asesor = await ctx.asesor();
    cat = await catalogos(ctx, admin);
    sedes = await prepararBanco(ctx, admin, ZONA);
    const tipo = await ctx
      .como(admin)
      .post('/v1/admin/tipos-alimento')
      .send({
        categoria_alimento_id: 5,
        unidad_medida_id: 1,
        codigo: 'lenteja_prueba',
        nombre: 'Lenteja (pruebas)',
        requiere_refrigeracion: false,
        tipo_almacenamiento: 'SECO',
        perecedero: false,
      })
      .expect(201);
    expect(tipo.body.codigo).toBe('LENTEJA_PRUEBA');
    tipoId = tipo.body.id;

    lotes.A = await loteDePrueba(10, enDias(10), 5);
    lotes.B = await loteDePrueba(6, enDias(2), 1);
    lotes.C = await loteDePrueba(8, null, 9);
    lotes.D = await loteDePrueba(5, enDias(-1), 20);
  });

  afterAll(async () => {
    await ctx.cerrar();
  });

  const pedido = (cantidad: number) => ({
    tipo_destino_id: cat.destino('FUNDACION'),
    nombre_destino: 'Fundación Manos Unidas',
    lineas: [{ tipo_alimento_id: tipoId, unidad_medida_id: 1, cantidad }],
  });

  it('la vista FEFO lista primero lo que vence antes, sin fecha al final y sin vencidos', async () => {
    const r = await ctx
      .como(asesor)
      .get(`/v1/inventario/lotes?tipo_alimento_id=${tipoId}`)
      .expect(200);
    expect(r.body.datos.map((l: { lote_id: string }) => l.lote_id)).toEqual([
      lotes.D,
      lotes.B,
      lotes.A,
      lotes.C,
    ]);
  });

  it('[FEFO 100 %] la salida toma el más próximo a vencer y nunca un lote vencido', async () => {
    const r = await ctx
      .como(asesor)
      .post('/v1/distribuciones')
      .send(pedido(9))
      .expect(201);
    const tomados = r.body.distribucion_detalle.map(
      (d: { lote_inventario: { id: string }; cantidad: number }) => [
        d.lote_inventario.id,
        d.cantidad,
      ],
    );
    expect(tomados).toEqual(
      expect.arrayContaining([
        [lotes.B, 6],
        [lotes.A, 3],
      ]),
    );
    expect(tomados).toHaveLength(2);

    const b = await ctx
      .como(asesor)
      .get(`/v1/inventario/lotes/${lotes.B}`)
      .expect(200);
    expect(b.body).toMatchObject({ cantidad_disponible: 0, estado: 'AGOTADO' });
    const d = await ctx
      .como(asesor)
      .get(`/v1/inventario/lotes/${lotes.D}`)
      .expect(200);
    expect(d.body.cantidad_disponible).toBe(5);
  });

  it('sin existencias vigentes suficientes responde 409 con lo que falta', async () => {
    const r = await ctx
      .como(asesor)
      .post('/v1/distribuciones')
      .send(pedido(100))
      .expect(409);
    expect(r.body.type).toBe('stock-insuficiente');
    expect(r.body.faltantes[0].faltante).toBe(85); // 7 de A + 8 de C disponibles
    const a = await ctx
      .como(asesor)
      .get(`/v1/inventario/lotes/${lotes.A}`)
      .expect(200);
    expect(a.body.cantidad_disponible).toBe(7); // la transacción no dejó rastro
  });

  it('ajustes: la merma a cero descarta el lote y un lote cerrado no admite más movimientos', async () => {
    const r = await ctx
      .como(asesor)
      .post(`/v1/inventario/lotes/${lotes.D}/ajuste`)
      .send({ tipo: 'VENCIMIENTO', cantidad: 5, motivo: 'Vencido en bodega' })
      .expect(200);
    expect(r.body).toMatchObject({ cantidad_disponible: 0, estado: 'VENCIDO' });

    const cerrado = await ctx
      .como(asesor)
      .post(`/v1/inventario/lotes/${lotes.D}/ajuste`)
      .send({ tipo: 'AJUSTE', cantidad: 1, motivo: 'Reconteo' })
      .expect(409);
    expect(cerrado.body.type).toBe('lote-cerrado');

    const excede = await ctx
      .como(asesor)
      .post(`/v1/inventario/lotes/${lotes.C}/ajuste`)
      .send({ tipo: 'AJUSTE', cantidad: 3, motivo: 'Reconteo' })
      .expect(422);
    expect(excede.body.type).toBe('saldo-invalido');

    await ctx
      .como(asesor)
      .post(`/v1/inventario/lotes/${lotes.C}/ajuste`)
      .send({ tipo: 'MERMA', cantidad: 2, motivo: 'Empaque roto' })
      .expect(200);
  });

  it('[libro mayor] el saldo de todo lote se reconstruye desde sus movimientos', async () => {
    const { rows } = await ctx.sql.query(`
      SELECT l.id, l.cantidad_disponible, coalesce(sum(m.cantidad), 0) AS reconstruido
        FROM lote_inventario l LEFT JOIN movimiento_inventario m ON m.lote_id = l.id
       GROUP BY l.id
      HAVING l.cantidad_disponible <> coalesce(sum(m.cantidad), 0)`);
    expect(rows).toEqual([]);
  });

  it('alertas de vencimiento: una por lote y tipo, con aviso a los asesores', async () => {
    await ctx
      .como(asesor)
      .post(`/v1/inventario/lotes/${lotes.A}/ajuste`)
      .send({ tipo: 'AJUSTE', cantidad: -1, motivo: 'Reconteo' })
      .expect(200);
    await ctx.sql.query(
      `UPDATE lote_inventario SET fecha_vencimiento = $2 WHERE id = $1`,
      [lotes.A, enDias(1)],
    );
    const servicio = ctx.app.get(LotesService);
    const nuevas = await servicio.generarAlertasVencimiento();
    expect(nuevas).toBeGreaterThanOrEqual(1);
    expect(await servicio.generarAlertasVencimiento()).toBe(0);

    const r = await ctx.como(asesor).get('/v1/alertas').expect(200);
    const alerta = r.body.find(
      (a: { lote_inventario: { id: string } | null }) =>
        a.lote_inventario?.id === lotes.A,
    );
    expect(alerta).toMatchObject({
      tipo: 'PROXIMO_VENCIMIENTO',
      nivel: 'ALTA',
    });

    const bandeja = await ctx
      .como(asesor)
      .get('/v1/me/notificaciones')
      .expect(200);
    expect(
      bandeja.body.datos.some(
        (n: { tipo: string }) => n.tipo === 'ALERTA_VENCIMIENTO',
      ),
    ).toBe(true);

    await ctx
      .como(asesor)
      .post(`/v1/alertas/${alerta.id}/atender`)
      .send({ accion_tomada: 'Priorizado para despacho' })
      .expect(200);
    await ctx
      .como(asesor)
      .post(`/v1/alertas/${alerta.id}/atender`)
      .send({ accion_tomada: 'Otra vez' })
      .expect(409);
  });

  it('recepción parcial: solo los productos aceptados generan lote y se registra el peso rechazado', async () => {
    const donante = await ctx.cuenta();
    const d = await ctx
      .como(donante)
      .post('/v1/donaciones')
      .send({
        ...ventana(3),
        direccion_recogida: 'Calle 50 # 50-50',
        ubicacion_recogida: ZONA,
        items: [
          {
            tipo_alimento_id: cat.tipo('ARROZ'),
            cantidad: 5,
            peso_estimado_kg: 5,
          },
          {
            tipo_alimento_id: cat.tipo('ENLATADOS'),
            cantidad: 12,
            peso_estimado_kg: 6,
          },
        ],
      })
      .expect(201);
    // Atajo de la prueba: la donación llegó a la sede.
    await ctx.sql.query(
      `UPDATE donacion SET estado = 'ENTREGADA', almacen_destino_id = $2, peso_recogido_kg = 11, entregada_at = now() WHERE id = $1`,
      [d.body.id, sedes.seco],
    );
    const enlatados = d.body.items.find(
      (i: { tipo_alimento: { codigo: string } }) =>
        i.tipo_alimento.codigo === 'ENLATADOS',
    );

    const sinMotivo = await ctx
      .como(asesor)
      .post('/v1/recepciones')
      .send({
        donacion_id: d.body.id,
        estado: 'ACEPTADA_PARCIAL',
        items: [{ donacion_item_id: enlatados.id }],
      })
      .expect(422);
    expect(sinMotivo.body.type).toBe('motivo-requerido');

    const r = await ctx
      .como(asesor)
      .post('/v1/recepciones')
      .send({
        donacion_id: d.body.id,
        estado: 'ACEPTADA_PARCIAL',
        motivo_id: cat.motivo('RECHAZO_RECEPCION', 'SIN_CAPACIDAD'),
        items: [
          {
            donacion_item_id: enlatados.id,
            cantidad_aceptada: 10,
            peso_aceptado_kg: 5,
          },
        ],
      })
      .expect(201);
    expect(r.body).toMatchObject({
      estado: 'ACEPTADA_PARCIAL',
      peso_recibido_kg: 5,
      peso_rechazado_kg: 6,
    });
    expect(r.body.lotes).toHaveLength(1);
    expect(r.body.lotes[0]).toMatchObject({
      cantidad_inicial: 10,
      peso_inicial_kg: 5,
    });

    const donacion = await ctx
      .como(donante)
      .get(`/v1/donaciones/${d.body.id}`)
      .expect(200);
    expect(donacion.body).toMatchObject({
      estado: 'RECIBIDA',
      peso_recibido_kg: 5,
    });
  });

  it('solo el personal ve el inventario', async () => {
    const donante = await ctx.cuenta();
    await ctx.como(donante).get('/v1/inventario/lotes').expect(403);
    await ctx
      .como(admin)
      .post(`/v1/inventario/lotes/${lotes.C}/ajuste`)
      .send({ tipo: 'MERMA', cantidad: 1, motivo: 'x' })
      .expect(403);
  });
});
