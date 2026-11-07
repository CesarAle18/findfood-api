import { randomUUID } from 'node:crypto';
import { EnvioNotificacionesService } from '../src/modulos/notificaciones/envio.service';
import {
  RUTA_MAX_ACTIVA_HORAS,
  RuteoService,
} from '../src/modulos/ruteo/ruteo.service';
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
 * Canal privado por usuario de Realtime (`usuario:<uuid>`, evento `sync`, §9.4 de
 * docs/arquitectura.md): solo lo lee su dueño con la cuenta ACTIVA, ningún cliente
 * emite en él y fn_rt_sincronizar deja un aviso por (usuario, entidad, id) en cada
 * transacción. Al final, los disparadores del flujo de una donación.
 */
describe('Sincronización en tiempo real: canal usuario:<uuid>', () => {
  let ctx: ContextoPruebas;
  let duena: Cuenta;
  let otra: Cuenta;

  const topico = (cuenta: Cuenta) => `usuario:${cuenta.id}`;
  const aviso = (entidad: string, id: string = randomUUID()) => ({
    v: 1,
    entidad,
    id,
  });
  const CLAVES_V1 = [
    'v',
    'entidad',
    'id',
    'donacion_id',
    'ruta_id',
    'asignacion_id',
    'tipo',
  ];

  beforeAll(async () => {
    ctx = await ContextoPruebas.crear();
    duena = await ctx.cuenta({ nombres: 'Dueña del canal' });
    otra = await ctx.cuenta({ nombres: 'Otra persona' });
  });

  afterAll(async () => {
    await ctx.cerrar();
  });

  /** Último id de realtime.messages: los mensajes de las otras suites se acumulan. */
  async function marca(): Promise<number> {
    const { rows } = await ctx.sql.query<{ id: string }>(
      'SELECT coalesce(max(id), 0) AS id FROM realtime.messages',
    );
    return Number(rows[0].id);
  }

  /** Payloads `sync` de `topic` posteriores a la marca, leídos sin RLS. */
  async function enviados(topic: string, desde: number) {
    const { rows } = await ctx.sql.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM realtime.messages
        WHERE topic = $1 AND event = 'sync' AND id > $2
        ORDER BY id`,
      [topic, desde],
    );
    return rows.map((m) => m.payload);
  }

  function sincronizar(
    usuarioId: string | null,
    payload: Record<string, unknown>,
  ) {
    return ctx.sql.query(
      'SELECT public.fn_rt_sincronizar($1::uuid, $2::jsonb)',
      [usuarioId, payload],
    );
  }

  /** Ejecuta `fn` en una transacción que se confirma. */
  async function enTransaccion(fn: () => Promise<unknown>) {
    await ctx.sql.query('BEGIN');
    try {
      await fn();
      await ctx.sql.query('COMMIT');
    } catch (e) {
      await ctx.sql.query('ROLLBACK');
      throw e;
    }
  }

  /**
   * Lo que decide Realtime al unirse a `topic`: las políticas de realtime.messages
   * evaluadas como `authenticated`, con auth.uid() tomado de request.jwt.claims y
   * realtime.topic() de la configuración realtime.topic (db/local/simulacion_supabase.sql).
   * Todo se deshace al terminar.
   */
  async function comoCliente<T>(
    cuenta: Cuenta,
    topic: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    await ctx.sql.query('BEGIN');
    try {
      await ctx.sql.query(
        `SELECT set_config('request.jwt.claims', json_build_object('sub', $1::text)::text, true),
                set_config('realtime.topic', $2, true)`,
        [cuenta.id, topic],
      );
      await ctx.sql.query('SET LOCAL ROLE authenticated');
      return await fn();
    } finally {
      await ctx.sql.query('ROLLBACK');
    }
  }

  /** Cuántos avisos `sync` posteriores a la marca lee `cuenta` al unirse a `topic`. */
  function legibles(cuenta: Cuenta, topic: string, desde: number) {
    return comoCliente(cuenta, topic, async () => {
      const { rows } = await ctx.sql.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM realtime.messages
          WHERE topic = $1 AND event = 'sync' AND id > $2`,
        [topic, desde],
      );
      return rows[0].n;
    });
  }

  describe('autorización del canal', () => {
    it('la dueña ACTIVA lee los avisos de su propio tópico', async () => {
      const desde = await marca();
      await sincronizar(duena.id, aviso('donacion'));
      expect(await legibles(duena, topico(duena), desde)).toBe(1);
    });

    it('otra cuenta no lee el tópico ajeno', async () => {
      const desde = await marca();
      await sincronizar(duena.id, aviso('donacion'));
      expect(await legibles(otra, topico(duena), desde)).toBe(0);
    });

    it('una cuenta SUSPENDIDA o eliminada no lee ni su propio tópico', async () => {
      const suspendida = await ctx.cuenta({ nombres: 'Suspendida' });
      const eliminada = await ctx.cuenta({ nombres: 'Eliminada' });
      await ctx.sql.query(
        `UPDATE usuario SET estado = 'SUSPENDIDO' WHERE id = $1`,
        [suspendida.id],
      );
      await ctx.sql.query(
        'UPDATE usuario SET deleted_at = now() WHERE id = $1',
        [eliminada.id],
      );
      const desde = await marca();
      for (const cuenta of [suspendida, eliminada]) {
        await sincronizar(cuenta.id, aviso('cuenta'));
        // El aviso existe; lo que falta es la autorización.
        expect(await enviados(topico(cuenta), desde)).toHaveLength(1);
        expect(await legibles(cuenta, topico(cuenta), desde)).toBe(0);
      }
    });

    it('ningún cliente emite en usuario:<uuid>, ni en el propio', async () => {
      await comoCliente(duena, topico(duena), async () => {
        await ctx.sql.query('SAVEPOINT emitir');
        await expect(
          ctx.sql.query(
            `INSERT INTO realtime.messages (topic, extension, event, payload, private)
             VALUES ($1, 'broadcast', 'sync', '{"v":1}', true)`,
            [topico(duena)],
          ),
        ).rejects.toMatchObject({
          code: '42501',
          message: expect.stringContaining('row-level security'),
        });
        await ctx.sql.query('ROLLBACK TO SAVEPOINT emitir');
      });
    });

    it('fn_rt_usuario_id solo acepta usuario:<uuid en minúsculas>', async () => {
      const id = duena.id;
      const invalidos = [
        null,
        'usuario:',
        'usuario:abc',
        'usuario:ABCDEF01-2345-4678-9ABC-DEF012345678',
        `USUARIO:${id}`,
        `usuario:${id}x`,
        `usuario:${id}:extra`,
        ` usuario:${id}`,
        `ruta:${id}`,
      ];
      const { rows } = await ctx.sql.query<{
        topico: string | null;
        id: string | null;
      }>(
        `SELECT t AS topico, public.fn_rt_usuario_id(t) AS id
           FROM unnest($1::text[]) WITH ORDINALITY AS x (t, n)
          ORDER BY n`,
        [[`usuario:${id}`, ...invalidos]],
      );
      expect(rows).toEqual([
        { topico: `usuario:${id}`, id },
        ...invalidos.map((t) => ({ topico: t, id: null })),
      ]);
    });
  });

  describe('fn_rt_sincronizar', () => {
    it('deja un aviso por (usuario, entidad, id) en cada transacción', async () => {
      const desde = await marca();
      const [a, b] = [randomUUID(), randomUUID()];
      await enTransaccion(async () => {
        await sincronizar(duena.id, aviso('donacion', a));
        await sincronizar(duena.id, aviso('donacion', a));
        await sincronizar(duena.id, aviso('donacion', b));
        await sincronizar(duena.id, aviso('asignacion', a));
        await sincronizar(otra.id, aviso('donacion', a));
      });
      expect(await enviados(topico(duena), desde)).toEqual([
        aviso('donacion', a),
        aviso('donacion', b),
        aviso('asignacion', a),
      ]);
      expect(await enviados(topico(otra), desde)).toEqual([
        aviso('donacion', a),
      ]);

      // La transacción siguiente vuelve a avisar.
      await enTransaccion(() => sincronizar(duena.id, aviso('donacion', a)));
      expect(await enviados(topico(duena), desde)).toHaveLength(4);
    });

    it('sin usuario no avisa, y el aviso no lleva claves nulas', async () => {
      const desde = await marca();
      const id = randomUUID();
      const delId = `SELECT topic, extension, event, private, payload
                       FROM realtime.messages
                      WHERE id > $1 AND payload->>'id' = $2`;

      await sincronizar(null, aviso('ruta', id));
      expect((await ctx.sql.query(delId, [desde, id])).rows).toEqual([]);

      // Sin `v`: la función pone la versión del contrato.
      await sincronizar(duena.id, {
        entidad: 'ruta',
        id,
        donacion_id: null,
        tipo: null,
      });
      // toEqual distingue una clave con null de una clave ausente.
      expect((await ctx.sql.query(delId, [desde, id])).rows).toEqual([
        {
          topic: topico(duena),
          extension: 'broadcast',
          event: 'sync',
          private: true,
          payload: { v: 1, entidad: 'ruta', id },
        },
      ]);
    });

    it('ningún cliente puede ejecutarla', async () => {
      const { rows } = await ctx.sql.query<{ rol: string; puede: boolean }>(
        `SELECT r AS rol,
                has_function_privilege(r, 'public.fn_rt_sincronizar(uuid, jsonb)', 'EXECUTE') AS puede
           FROM unnest(ARRAY['anon', 'authenticated']) AS r`,
      );
      expect(rows).toEqual([
        { rol: 'anon', puede: false },
        { rol: 'authenticated', puede: false },
      ]);
      await comoCliente(duena, topico(duena), async () => {
        await expect(
          sincronizar(duena.id, aviso('cuenta')),
        ).rejects.toMatchObject({ code: '42501' });
      });
    });
  });

  /**
   * Disparadores de donacion, asignacion, parada_ruta y ruta: quién recibe cada
   * aviso a lo largo de una ruta con dos donantes. Zona propia: los dos
   * voluntarios de aquí reciben todas las ofertas. Los pasos dependen del anterior.
   */
  describe('disparadores del flujo', () => {
    const ZONA = { lat: 1.21, lng: -77.28 };
    const cerca = (d: number) => ({ lat: ZONA.lat + d, lng: ZONA.lng + d });
    const ENTIDADES_FLUJO = ['donacion', 'asignacion', 'parada', 'ruta'];
    let cat: Catalogos;
    let ganador: Voluntario;
    let perdedor: Voluntario;
    let donanteA: Cuenta;
    let donanteB: Cuenta;
    let donacionA: string;
    let donacionB: string;
    let ofertasA: Record<string, string>;
    let rutaId: string;
    let inicio: number;
    /** Dueño y punto de recogida de cada donación. */
    const datos = new Map<
      string,
      { donante: Cuenta; punto: { lat: number; lng: number } }
    >();

    const donacion = (id: string) => ({ v: 1, entidad: 'donacion', id });

    /** Avisos del flujo para `cuenta` desde la marca (bandeja y cuenta van aparte). */
    async function avisos(cuenta: Cuenta, desde: number) {
      return (await enviados(topico(cuenta), desde)).filter((p) =>
        ENTIDADES_FLUJO.includes(p.entidad as string),
      );
    }

    async function crear(cuenta: Cuenta, punto: { lat: number; lng: number }) {
      const r = await ctx
        .como(cuenta)
        .post('/v1/donaciones')
        .send({
          ...ventana(4),
          direccion_recogida: 'Calle 18 # 25-30',
          ubicacion_recogida: punto,
          items: [
            {
              tipo_alimento_id: cat.tipo('ARROZ'),
              cantidad: 10,
              peso_estimado_kg: 10,
            },
          ],
        })
        .expect(201);
      datos.set(r.body.id, { donante: cuenta, punto });
      return r.body.id as string;
    }

    /** Publica y devuelve las ofertas creadas, por voluntario. */
    async function publicar(cuenta: Cuenta, id: string) {
      await ctx.como(cuenta).post(`/v1/donaciones/${id}/publicar`).expect(200);
      const { rows } = await ctx.sql.query<{
        id: string;
        voluntario_id: string;
      }>(
        `SELECT id, voluntario_id FROM asignacion
          WHERE donacion_id = $1 AND estado = 'OFRECIDA'`,
        [id],
      );
      return Object.fromEntries(rows.map((a) => [a.voluntario_id, a.id]));
    }

    async function paradas() {
      const { rows } = await ctx.sql.query<{
        id: string;
        tipo: string;
        donacion_id: string | null;
      }>(
        `SELECT id, tipo::text AS tipo, donacion_id FROM parada_ruta
          WHERE ruta_id = $1 ORDER BY orden`,
        [rutaId],
      );
      return rows;
    }

    function llegada(parada: { id: string; donacion_id: string | null }) {
      return ctx
        .como(ganador)
        .post(`/v1/paradas/${parada.id}/llegada`)
        .send({ ubicacion: datos.get(parada.donacion_id!)!.punto })
        .expect(200);
    }

    /** Evidencia + confirmación manual de una recogida. */
    async function confirmar(paradaId: string) {
      await ctx
        .como(ganador)
        .post('/v1/evidencias')
        .send({
          id: randomUUID(),
          tipo: 'RECOGIDA',
          ruta: await ctx.ruta(ganador, 'EVIDENCIA'),
          parada_id: paradaId,
          capturada_at: new Date().toISOString(),
        })
        .expect(201);
      await ctx
        .como(ganador)
        .post(`/v1/paradas/${paradaId}/confirmar`)
        .send({
          confirmacion_manual: true,
          confirmada_en_dispositivo: new Date().toISOString(),
          peso_confirmado_kg: 10,
        })
        .expect(200);
    }

    beforeAll(async () => {
      const admin = await ctx.admin();
      cat = await catalogos(ctx, admin);
      await prepararBanco(ctx, admin, ZONA);
      ganador = await ctx.voluntario(admin, cerca(0.002));
      perdedor = await ctx.voluntario(admin, cerca(0.03));
      donanteA = await ctx.cuenta({ nombres: 'Donante A' });
      donanteB = await ctx.cuenta({ nombres: 'Donante B' });
      inicio = await marca();
    });

    it('un BORRADOR no avisa; al publicar avisan el donante y cada oferta a su voluntario', async () => {
      let desde = await marca();
      donacionA = await crear(donanteA, cerca(0.01));
      expect(await avisos(donanteA, desde)).toEqual([]);

      desde = await marca();
      ofertasA = await publicar(donanteA, donacionA);
      expect(Object.keys(ofertasA).sort()).toEqual(
        [ganador.voluntarioId, perdedor.voluntarioId].sort(),
      );
      // Las ofertas se crean en otra transacción: un aviso por oferta al
      // donante se vería aquí como un segundo mensaje.
      expect(await avisos(donanteA, desde)).toEqual([donacion(donacionA)]);
      for (const vol of [ganador, perdedor]) {
        expect(await avisos(vol, desde)).toEqual([
          {
            v: 1,
            entidad: 'asignacion',
            id: ofertasA[vol.voluntarioId],
            donacion_id: donacionA,
          },
        ]);
      }

      // El panel sigue recibiendo su mensaje en banco:donaciones (§9.1).
      const { rows } = await ctx.sql.query(
        `SELECT payload->>'estado' AS estado FROM realtime.messages
          WHERE topic = 'banco:donaciones' AND event = 'donacion_estado'
            AND id > $1 AND payload->>'id' = $2`,
        [desde, donacionA],
      );
      expect(rows).toEqual([{ estado: 'PUBLICADA' }]);
    });

    it('aceptar: un aviso al donante, la oferta cerrada a quien perdió y la ruta al ganador', async () => {
      const desde = await marca();
      const r = await ctx
        .como(ganador)
        .post(`/v1/asignaciones/${ofertasA[ganador.voluntarioId]}/aceptar`)
        .expect(200);
      rutaId = r.body.ruta.id;
      const [recogida, entrega] = await paradas();

      // PUBLICADA → ASIGNADA → EN_RECOLECCION, la oferta aceptada, la parada y el
      // cierre de la otra oferta caben en un solo aviso al donante.
      expect(await avisos(donanteA, desde)).toEqual([donacion(donacionA)]);
      expect(await avisos(perdedor, desde)).toContainEqual({
        v: 1,
        entidad: 'asignacion',
        id: ofertasA[perdedor.voluntarioId],
        donacion_id: donacionA,
      });
      expect(await avisos(ganador, desde)).toEqual(
        expect.arrayContaining([
          {
            v: 1,
            entidad: 'asignacion',
            id: ofertasA[ganador.voluntarioId],
            donacion_id: donacionA,
            ruta_id: rutaId,
          },
          {
            v: 1,
            entidad: 'parada',
            id: recogida.id,
            ruta_id: rutaId,
            donacion_id: donacionA,
          },
          { v: 1, entidad: 'parada', id: entrega.id, ruta_id: rutaId },
          { v: 1, entidad: 'ruta', id: rutaId },
        ]),
      );
    });

    it('reordenar paradas o cambiar su ETA no avisa: solo la parada nueva', async () => {
      donacionB = await crear(donanteB, cerca(0.005));
      const ofertasB = await publicar(donanteB, donacionB);
      const desde = await marca();
      await ctx
        .como(ganador)
        .post(`/v1/asignaciones/${ofertasB[ganador.voluntarioId]}/aceptar`)
        .expect(200);
      const nueva = (await paradas()).find((p) => p.donacion_id === donacionB)!;

      // Aceptar reescribe el orden y la ETA de las demás paradas, fila por fila.
      const deParadas = (await avisos(ganador, desde)).filter(
        (p) => p.entidad === 'parada',
      );
      expect(deParadas).toEqual([
        {
          v: 1,
          entidad: 'parada',
          id: nueva.id,
          ruta_id: rutaId,
          donacion_id: donacionB,
        },
      ]);
      // A sigue en la ruta y su seguimiento cambia: recibe su propia donación.
      expect(await avisos(donanteA, desde)).toEqual([donacion(donacionA)]);
      expect(await avisos(donanteB, desde)).toEqual([donacion(donacionB)]);

      // Ni la ETA ni un estado que no cambia avisan.
      const quieta = await marca();
      await ctx.sql.query(
        `UPDATE parada_ruta SET hora_estimada_llegada = hora_estimada_llegada + interval '5 minutes'
          WHERE ruta_id = $1`,
        [rutaId],
      );
      await ctx.sql.query(
        'UPDATE parada_ruta SET estado = estado WHERE ruta_id = $1',
        [rutaId],
      );
      await ctx.sql.query(
        'UPDATE ruta SET estado = estado, duracion_estimada_min = 99 WHERE id = $1',
        [rutaId],
      );
      const { rows } = await ctx.sql.query(
        `SELECT payload FROM realtime.messages WHERE event = 'sync' AND id > $1`,
        [quieta],
      );
      expect(rows).toEqual([]);
    });

    it('llegada a una ruta con dos donantes: cada uno recibe solo su donación', async () => {
      const [primera] = (await paradas()).filter((p) => p.tipo === 'RECOGIDA');
      const desde = await marca();
      await llegada(primera);

      expect(await avisos(donanteA, desde)).toEqual([donacion(donacionA)]);
      expect(await avisos(donanteB, desde)).toEqual([donacion(donacionB)]);
      expect(await avisos(ganador, desde)).toContainEqual({
        v: 1,
        entidad: 'parada',
        id: primera.id,
        ruta_id: rutaId,
        donacion_id: primera.donacion_id,
      });
    });

    it('camino al banco, el donante ya recogido se entera de la otra recogida', async () => {
      const [primera, segunda] = (await paradas()).filter(
        (p) => p.tipo === 'RECOGIDA',
      );
      await confirmar(primera.id);
      const desde = await marca();
      await llegada(segunda);

      // Su ventana de seguimiento depende de las recogidas ajenas (§9.2).
      for (const p of [primera, segunda]) {
        expect(await avisos(datos.get(p.donacion_id!)!.donante, desde)).toEqual(
          [donacion(p.donacion_id!)],
        );
      }
    });

    it('la ruta cancelada por la tarea programada avisa a su voluntario', async () => {
      await ctx.sql.query(
        `UPDATE ruta SET created_at = now() - make_interval(hours => $2) WHERE id = $1`,
        [rutaId, RUTA_MAX_ACTIVA_HORAS + 1],
      );
      const desde = await marca();
      expect(
        await ctx.app.get(RuteoService).cancelarRutasVencidas(),
      ).toBeGreaterThanOrEqual(1);

      expect(await avisos(ganador, desde)).toContainEqual({
        v: 1,
        entidad: 'ruta',
        id: rutaId,
      });
      expect(await avisos(donanteA, desde)).toEqual([donacion(donacionA)]);
      expect(await avisos(donanteB, desde)).toEqual([donacion(donacionB)]);
    });

    it('los avisos solo llevan claves del contrato v1 y ningún donante ve ids ajenos', async () => {
      const { rows } = await ctx.sql.query<{
        payload: Record<string, unknown>;
      }>(
        `SELECT payload FROM realtime.messages WHERE event = 'sync' AND id > $1`,
        [inicio],
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const { payload } of rows) {
        expect(CLAVES_V1).toEqual(expect.arrayContaining(Object.keys(payload)));
        expect(payload.v).toBe(1);
      }

      const todas = await paradas();
      const ids = (d: string) => [
        d,
        ...todas.filter((p) => p.donacion_id === d).map((p) => p.id),
      ];
      for (const [cuenta, propia, ajena] of [
        [donanteA, donacionA, donacionB],
        [donanteB, donacionB, donacionA],
      ] as const) {
        const recibidos = await avisos(cuenta, inicio);
        // El donante solo recibe su donación: ni ofertas, ni paradas, ni la ruta.
        expect(recibidos.length).toBeGreaterThan(0);
        expect(recibidos).toEqual(recibidos.map(() => donacion(propia)));
        const texto = JSON.stringify(await enviados(topico(cuenta), inicio));
        for (const id of [...ids(ajena), rutaId]) {
          expect(texto).not.toContain(id);
        }
      }
    });
  });

  /**
   * Disparadores de notificacion (la bandeja) y de usuario, usuario_rol y
   * voluntario (la cuenta): cada persona recibe solo lo suyo, y lo que se
   * escribe a cada rato (ubicación, último acceso, envío del push, marcar
   * leídas, contadores) no avisa. Zona propia; los pasos dependen del anterior.
   */
  describe('disparadores de bandeja y cuenta', () => {
    const ZONA = { lat: 1.62, lng: -75.6 };
    const cerca = (d: number) => ({ lat: ZONA.lat + d, lng: ZONA.lng + d });
    let admin: Cuenta;
    let volA: Voluntario;
    let volB: Voluntario;
    let donante: Cuenta;
    let inicio: number;

    const cuenta = (c: Cuenta) => ({ v: 1, entidad: 'cuenta', id: c.id });

    /** Avisos `sync` de cualquier tópico desde la marca. */
    async function todos(desde: number) {
      const { rows } = await ctx.sql.query(
        `SELECT topic, payload FROM realtime.messages
          WHERE event = 'sync' AND id > $1 ORDER BY id`,
        [desde],
      );
      return rows;
    }

    /** Id de la notificación `codigo` de `c` (la única, o la de `asignacionId`). */
    async function notificacion(
      c: Cuenta,
      codigo: string,
      asignacionId?: string,
    ) {
      const { rows } = await ctx.sql.query<{ id: string }>(
        `SELECT n.id FROM notificacion n
           JOIN tipo_notificacion t ON t.id = n.tipo_notificacion_id
          WHERE n.usuario_id = $1 AND t.codigo = $2
            AND ($3::uuid IS NULL OR n.asignacion_id = $3)`,
        [c.id, codigo, asignacionId ?? null],
      );
      expect(rows).toHaveLength(1);
      return rows[0].id;
    }

    beforeAll(async () => {
      inicio = await marca();
      admin = await ctx.admin();
      await prepararBanco(ctx, admin, ZONA);
      volA = await ctx.voluntario(admin, cerca(0.002));
      volB = await ctx.voluntario(admin, cerca(0.01));
      donante = await ctx.cuenta({ nombres: 'Donante de la bandeja' });
    });

    it('al publicar, cada voluntario recibe su notificación ASIGNACION_OFRECIDA', async () => {
      const cat = await catalogos(ctx, admin);
      const { body } = await ctx
        .como(donante)
        .post('/v1/donaciones')
        .send({
          ...ventana(4),
          direccion_recogida: 'Calle 10 # 5-20',
          ubicacion_recogida: cerca(0.005),
          items: [
            {
              tipo_alimento_id: cat.tipo('ARROZ'),
              cantidad: 10,
              peso_estimado_kg: 10,
            },
          ],
        })
        .expect(201);
      const donacionId = body.id as string;
      const desde = await marca();
      await ctx
        .como(donante)
        .post(`/v1/donaciones/${donacionId}/publicar`)
        .expect(200);

      const { rows: ofertas } = await ctx.sql.query<{
        id: string;
        voluntario_id: string;
      }>(
        `SELECT id, voluntario_id FROM asignacion
          WHERE donacion_id = $1 AND estado = 'OFRECIDA'`,
        [donacionId],
      );
      expect(ofertas.map((o) => o.voluntario_id).sort()).toEqual(
        [volA.voluntarioId, volB.voluntarioId].sort(),
      );
      for (const vol of [volA, volB]) {
        const oferta = ofertas.find(
          (o) => o.voluntario_id === vol.voluntarioId,
        )!;
        const recibidos = (await enviados(topico(vol), desde)).filter(
          (p) => p.entidad === 'notificacion',
        );
        // Solo la suya: la del otro voluntario va a su propio tópico.
        expect(recibidos).toEqual([
          {
            v: 1,
            entidad: 'notificacion',
            id: await notificacion(vol, 'ASIGNACION_OFRECIDA', oferta.id),
            tipo: 'ASIGNACION_OFRECIDA',
            donacion_id: donacionId,
            asignacion_id: oferta.id,
          },
        ]);
      }
    });

    it('enviar el push y marcar leídas no avisan', async () => {
      await ctx
        .como(volA)
        .post('/v1/me/dispositivos')
        .send({
          token_push: `ExponentPushToken[sync-${volA.id.slice(0, 8)}]`,
          plataforma: 'ANDROID',
        })
        .expect(201);
      const desde = await marca();

      // La tarea enviar_notificaciones; las suites anteriores dejan pendientes.
      const envio = ctx.app.get(EnvioNotificacionesService);
      for (let lote = 0; lote < 20; lote++) {
        const r = await envio.procesarPendientes();
        if (!r.enviadas && !r.fallidas) break;
      }
      const estados = await ctx.sql.query<{ estado: string }>(
        `SELECT DISTINCT estado_envio::text AS estado FROM notificacion
          WHERE usuario_id = $1`,
        [volA.id],
      );
      expect(estados.rows).toEqual([{ estado: 'ENVIADA' }]);

      const bandeja = await ctx
        .como(volA)
        .get('/v1/me/notificaciones')
        .expect(200);
      expect(bandeja.body.no_leidas).toBeGreaterThanOrEqual(2);
      await ctx
        .como(volA)
        .post(`/v1/me/notificaciones/${bandeja.body.datos[0].id}/leer`)
        .expect(204);
      const todas = await ctx
        .como(volA)
        .post('/v1/me/notificaciones/leer-todas')
        .expect(200);
      expect(todas.body.actualizadas).toBeGreaterThanOrEqual(1);

      expect(await todos(desde)).toEqual([]);
    });

    it('la ubicación, el último acceso y los contadores no avisan', async () => {
      const desde = await marca();
      await ctx
        .como(volA)
        .post('/v1/voluntario/ubicacion')
        .send(cerca(0.004))
        .expect(200);
      // Lo que escribe el AuthGuard, y columnas de cuenta que no cambian.
      await ctx.sql.query(
        `UPDATE usuario
            SET ultimo_acceso_at = now(), updated_at = now(),
                estado = estado, debe_cambiar_password = debe_cambiar_password
          WHERE id = $1`,
        [volA.id],
      );
      // Lo que escriben la recepción y las calificaciones.
      await ctx.sql.query(
        `UPDATE voluntario
            SET total_entregas = total_entregas + 1,
                total_kg_transportados = total_kg_transportados + 10,
                calificacion_promedio = 4.5, updated_at = now(),
                disponible = disponible, estado_verificacion = estado_verificacion
          WHERE usuario_id = $1`,
        [volA.id],
      );
      await ctx.sql.query(
        'UPDATE usuario_rol SET activo = activo WHERE usuario_id = $1',
        [volA.id],
      );

      const { rows } = await ctx.sql.query(
        `SELECT 1 FROM voluntario
          WHERE usuario_id = $1 AND ultima_ubicacion_at > now() - interval '1 minute'`,
        [volA.id],
      );
      expect(rows).toHaveLength(1);
      expect(await todos(desde)).toEqual([]);
    });

    it('el interruptor de disponibilidad avisa a la cuenta del voluntario', async () => {
      for (const disponible of [false, true]) {
        const desde = await marca();
        await ctx
          .como(volB)
          .patch('/v1/voluntario/estado')
          .send({ disponible })
          .expect(200);
        expect(await enviados(topico(volB), desde)).toEqual([cuenta(volB)]);
      }
      // Sin cambio, sin aviso.
      const desde = await marca();
      await ctx
        .como(volB)
        .patch('/v1/voluntario/estado')
        .send({ disponible: true })
        .expect(200);
      expect(await todos(desde)).toEqual([]);
    });

    it('la solicitud y su aprobación avisan a la cuenta; la aprobación llega a la bandeja', async () => {
      const persona = await ctx.cuenta({ nombres: 'Solicitante' });
      let desde = await marca();
      const { verificacionId } = await ctx.solicitudVoluntario(
        persona,
        cerca(0.02),
      );
      // voluntario y usuario_rol nacen en la misma transacción: un aviso.
      expect(await enviados(topico(persona), desde)).toEqual([cuenta(persona)]);

      desde = await marca();
      await ctx
        .como(admin)
        .post(`/v1/admin/verificaciones/${verificacionId}/aprobar`)
        .expect(200);
      // El rol y el perfil de voluntario cambian juntos (DDL §17.2): un aviso.
      expect(await enviados(topico(persona), desde)).toEqual([
        cuenta(persona),
        {
          v: 1,
          entidad: 'notificacion',
          id: await notificacion(persona, 'VERIFICACION_APROBADA'),
          tipo: 'VERIFICACION_APROBADA',
        },
      ]);
    });

    it('suspender y reactivar avisan a la cuenta', async () => {
      let desde = await marca();
      await ctx
        .como(admin)
        .post(`/v1/admin/usuarios/${volB.id}/suspender`)
        .send({ descripcion: 'Prueba de sincronización' })
        .expect(200);
      // estado y disponible cambian en la misma transacción: un aviso.
      expect(await enviados(topico(volB), desde)).toEqual([cuenta(volB)]);

      desde = await marca();
      await ctx
        .como(admin)
        .post(`/v1/admin/usuarios/${volB.id}/reactivar`)
        .expect(200);
      expect(await enviados(topico(volB), desde)).toEqual([cuenta(volB)]);
    });

    it('solo claves del contrato v1, y cada quien recibe solo su notificación y su cuenta', async () => {
      // El tópico que corresponde: el de la propia cuenta o el del destinatario.
      const { rows } = await ctx.sql.query<{
        topic: string;
        payload: Record<string, unknown>;
        esperado: string | null;
      }>(
        `SELECT m.topic, m.payload,
                'usuario:' || CASE m.payload->>'entidad'
                                WHEN 'cuenta' THEN m.payload->>'id'
                                ELSE n.usuario_id::text
                              END AS esperado
           FROM realtime.messages m
           LEFT JOIN notificacion n ON n.id::text = m.payload->>'id'
          WHERE m.event = 'sync' AND m.id > $1
            AND m.payload->>'entidad' IN ('notificacion', 'cuenta')`,
        [inicio],
      );
      expect(new Set(rows.map((r) => r.payload.entidad))).toEqual(
        new Set(['notificacion', 'cuenta']),
      );
      for (const { topic, payload, esperado } of rows) {
        expect(CLAVES_V1).toEqual(expect.arrayContaining(Object.keys(payload)));
        expect(payload.v).toBe(1);
        expect(topic).toBe(esperado);
      }
    });
  });
});
