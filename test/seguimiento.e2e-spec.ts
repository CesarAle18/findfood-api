import { randomUUID } from 'node:crypto';
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

  /**
   * API-06: el donante sigue al voluntario hacia su recogida y luego al banco, hasta la
   * entrega. Zona aparte para tener una ruta nueva con un solo voluntario.
   */
  describe('seguimiento de la donación por el donante', () => {
    const ZONA_D = { lat: 2.75, lng: -76.9 };
    const cercaD = (d: number) => ({ lat: ZONA_D.lat + d, lng: ZONA_D.lng + d });
    const DIRECCION_AJENA = 'Carrera 99 # 88-77 Casa de otro donante';
    let sedesD: { seco: string };
    let volD: Voluntario;
    let donanteA: Cuenta;
    let donanteB: Cuenta;
    let donacionA: string;
    let donacionB: string;
    let rutaD: string;

    /** Publica una donación de `cuenta` y devuelve su id y la oferta hecha a volD. */
    async function publicar(
      cuenta: Cuenta,
      ubicacion: { lat: number; lng: number },
      direccion: string,
    ) {
      const r = await ctx
        .como(cuenta)
        .post('/v1/donaciones')
        .send({
          ...ventana(4),
          direccion_recogida: direccion,
          ubicacion_recogida: ubicacion,
          items: [
            { tipo_alimento_id: cat.tipo('ARROZ'), cantidad: 10, peso_estimado_kg: 10 },
          ],
        })
        .expect(201);
      await ctx.como(cuenta).post(`/v1/donaciones/${r.body.id}/publicar`).expect(200);
      const { rows } = await ctx.sql.query<{ id: string; voluntario_id: string }>(
        `SELECT id, voluntario_id FROM asignacion
          WHERE donacion_id = $1 AND estado = 'OFRECIDA'`,
        [r.body.id],
      );
      expect(rows[0].voluntario_id).toBe(volD.voluntarioId);
      const aceptada = await ctx
        .como(volD)
        .post(`/v1/asignaciones/${rows[0].id}/aceptar`)
        .expect(200);
      return { donacion: r.body.id as string, ruta: aceptada.body.ruta.id as string };
    }

    /** Evidencia + confirmación manual de una parada. */
    async function confirmar(paradaId: string, tipo: 'RECOGIDA' | 'ENTREGA') {
      await ctx
        .como(volD)
        .post('/v1/evidencias')
        .send({
          id: randomUUID(),
          tipo,
          ruta: await ctx.ruta(volD, 'EVIDENCIA'),
          parada_id: paradaId,
          capturada_at: new Date().toISOString(),
        })
        .expect(201);
      await ctx
        .como(volD)
        .post(`/v1/paradas/${paradaId}/confirmar`)
        .send({
          confirmacion_manual: true,
          confirmada_en_dispositivo: new Date().toISOString(),
          ...(tipo === 'RECOGIDA' ? { peso_confirmado_kg: 10 } : {}),
        })
        .expect(200);
    }

    async function paradas() {
      const r = await ctx.como(volD).get(`/v1/rutas/${rutaD}`).expect(200);
      return r.body.paradas as {
        id: string;
        tipo: string;
        donacion_id: string | null;
      }[];
    }

    /**
     * Lo que decide Realtime al unirse al canal ruta:<id>: fn_rt_es_donante_de_ruta como
     * `authenticated`, con auth.uid() tomado de request.jwt.claims (db/local/simulacion_supabase.sql).
     */
    async function realtimeDeja(cuenta: Cuenta): Promise<boolean> {
      await ctx.sql.query('BEGIN');
      try {
        await ctx.sql.query(
          `SELECT set_config('request.jwt.claims', json_build_object('sub', $1::text)::text, true)`,
          [cuenta.id],
        );
        await ctx.sql.query('SET LOCAL ROLE authenticated');
        const { rows } = await ctx.sql.query<{ ok: boolean }>(
          'SELECT public.fn_rt_es_donante_de_ruta($1::uuid) AS ok',
          [rutaD],
        );
        return rows[0].ok;
      } finally {
        await ctx.sql.query('ROLLBACK');
      }
    }

    const seguimiento = (cuenta: Cuenta, donacion: string) =>
      ctx.como(cuenta).get(`/v1/donaciones/${donacion}/seguimiento`);

    /** Realtime deja escuchar ruta:<id> exactamente cuando el endpoint entrega ruta_id. */
    async function mismaVentana(cuenta: Cuenta, body: { ruta_id: string | null }) {
      expect(await realtimeDeja(cuenta)).toBe(body.ruta_id !== null);
    }

    beforeAll(async () => {
      sedesD = await prepararBanco(ctx, admin, ZONA_D);
      volD = await ctx.voluntario(admin, cercaD(0.001));
      donanteA = await ctx.cuenta({ nombres: 'Donante A' });
      donanteB = await ctx.cuenta({ nombres: 'Donante B' });
    });

    it('HACIA_RECOGIDA: posición reciente del voluntario y tramo hasta el punto del donante', async () => {
      ({ donacion: donacionA, ruta: rutaD } = await publicar(
        donanteA,
        cercaD(0.01),
        'Calle 5 # 6-7',
      ));
      await ctx.como(volD).post('/v1/voluntario/ubicacion').send(cercaD(0.002)).expect(200);

      const r = await seguimiento(donanteA, donacionA).expect(200);
      expect(r.body).toMatchObject({
        donacion_id: donacionA,
        activo: true,
        fase: 'HACIA_RECOGIDA',
        ruta_id: rutaD,
        paradas_antes: 0,
        recogida: { direccion: 'Calle 5 # 6-7' },
        banco: { id: sedesD.seco },
        voluntario_posicion: { ...cercaD(0.002), fuente: 'ULTIMA_UBICACION' },
      });
      const { recogida, tramo } = r.body;
      expect(recogida.lat).toBeCloseTo(cercaD(0.01).lat, 6);
      expect(tramo.proveedor).toBe('ESTIMADO');
      expect(tramo.trayecto.coordinates.at(-1)).toEqual([recogida.lng, recogida.lat]);
      await mismaVentana(donanteA, r.body);
      expect(await realtimeDeja(donanteA)).toBe(true);
      expect(await realtimeDeja(donanteB)).toBe(false);
    });

    it('solo el donante dueño y el personal; el voluntario usa /rutas/:id/seguimiento', async () => {
      await seguimiento(donanteB, donacionA).expect(404);
      // El voluntario también tiene el rol DONANTE: pasa el RolesGuard pero no es el dueño.
      await seguimiento(volD, donacionA).expect(404);
      const r = await seguimiento(asesor, donacionA).expect(200);
      expect(r.body.activo).toBe(true);
      await seguimiento(admin, donacionA).expect(200);
      await seguimiento(donanteA, randomUUID()).expect(404);
      await seguimiento(donanteA, 'no-es-uuid').expect(400);
    });

    it('HACIA_BANCO: tras confirmar la recogida el tramo apunta al banco', async () => {
      const recogidaA = (await paradas()).find((p) => p.donacion_id === donacionA)!;
      await confirmar(recogidaA.id, 'RECOGIDA');

      const r = await seguimiento(donanteA, donacionA).expect(200);
      expect(r.body).toMatchObject({
        estado_donacion: 'EN_TRANSITO',
        activo: true,
        fase: 'HACIA_BANCO',
        ruta_id: rutaD,
        paradas_antes: 0,
      });
      const { banco, tramo } = r.body;
      expect(tramo.trayecto.coordinates.at(-1)).toEqual([banco.lng, banco.lat]);
      await mismaVentana(donanteA, r.body);
      expect(await realtimeDeja(donanteA)).toBe(true);
    });

    it('con otra recogida antes del banco: solo un conteo, sin posición, tramo ni datos ajenos', async () => {
      ({ donacion: donacionB } = await publicar(donanteB, cercaD(0.005), DIRECCION_AJENA));
      const ajena = (await paradas()).find((p) => p.donacion_id === donacionB)!;

      // La posición del voluntario en casa de B revelaría su dirección: A no la ve.
      const r = await seguimiento(donanteA, donacionA).expect(200);
      expect(r.body).toMatchObject({
        activo: true,
        fase: 'HACIA_BANCO',
        ruta_id: null,
        voluntario_posicion: null,
        tramo: null,
      });
      expect(r.body.paradas_antes).toBeGreaterThanOrEqual(1);
      const texto = JSON.stringify(r.body);
      expect(texto).not.toContain(DIRECCION_AJENA);
      expect(texto).not.toContain(donacionB);
      expect(texto).not.toContain(ajena.id);
      expect(texto).not.toContain(rutaD);
      await mismaVentana(donanteA, r.body);
      expect(await realtimeDeja(donanteA)).toBe(false);

      // El donante B va primero: él sí ve al voluntario y el tramo hacia su punto.
      const b = await seguimiento(donanteB, donacionB).expect(200);
      expect(b.body).toMatchObject({
        fase: 'HACIA_RECOGIDA',
        ruta_id: rutaD,
        paradas_antes: 0,
        voluntario_posicion: { fuente: 'ULTIMA_UBICACION' },
      });
      expect(b.body.tramo).not.toBeNull();
      await mismaVentana(donanteB, b.body);
      expect(await realtimeDeja(donanteB)).toBe(true);
    });

    it('al recoger la otra donación vuelven la posición y el canal camino al banco', async () => {
      await confirmar((await paradas()).find((p) => p.donacion_id === donacionB)!.id, 'RECOGIDA');

      const r = await seguimiento(donanteA, donacionA).expect(200);
      expect(r.body).toMatchObject({
        activo: true,
        fase: 'HACIA_BANCO',
        ruta_id: rutaD,
        paradas_antes: 0,
        voluntario_posicion: { fuente: 'ULTIMA_UBICACION' },
      });
      const { banco, tramo } = r.body;
      expect(tramo.trayecto.coordinates.at(-1)).toEqual([banco.lng, banco.lat]);
      await mismaVentana(donanteA, r.body);
      expect(await realtimeDeja(donanteA)).toBe(true);

      const b = await seguimiento(donanteB, donacionB).expect(200);
      expect(b.body).toMatchObject({ fase: 'HACIA_BANCO', ruta_id: rutaD, paradas_antes: 0 });
      await mismaVentana(donanteB, b.body);
    });

    it('tras la entrega en el banco se cierra la ventana (API y Realtime)', async () => {
      await confirmar((await paradas()).find((p) => p.tipo === 'ENTREGA')!.id, 'ENTREGA');

      const r = await seguimiento(donanteA, donacionA).expect(200);
      expect(r.body).toMatchObject({
        estado_donacion: 'ENTREGADA',
        activo: false,
        fase: null,
        ruta_id: null,
        paradas_antes: 0,
        voluntario_posicion: null,
        tramo: null,
        recogida: { direccion: 'Calle 5 # 6-7' },
        banco: { id: sedesD.seco },
      });
      await mismaVentana(donanteA, r.body);
      const b = await seguimiento(donanteB, donacionB).expect(200);
      expect(b.body).toMatchObject({ activo: false, ruta_id: null });
      await mismaVentana(donanteB, b.body);
      expect(await realtimeDeja(donanteA)).toBe(false);
      expect(await realtimeDeja(donanteB)).toBe(false);
    });

    it('una donación sin ruta responde inactiva', async () => {
      const r = await ctx
        .como(donanteA)
        .post('/v1/donaciones')
        .send({
          ...ventana(4),
          direccion_recogida: 'Calle 1 # 2-3',
          ubicacion_recogida: cercaD(0.02),
          items: [
            { tipo_alimento_id: cat.tipo('ARROZ'), cantidad: 1, peso_estimado_kg: 1 },
          ],
        })
        .expect(201);
      const s = await seguimiento(donanteA, r.body.id).expect(200);
      expect(s.body).toMatchObject({
        estado_donacion: 'BORRADOR',
        activo: false,
        ruta_id: null,
        banco: null,
        recogida: { direccion: 'Calle 1 # 2-3' },
      });
    });
  });
});
