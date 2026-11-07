import { randomUUID } from 'node:crypto';
import { type Cuenta, ContextoPruebas } from './utilidades/app-de-pruebas';

/**
 * Canal privado por usuario de Realtime (`usuario:<uuid>`, evento `sync`, §9.4 de
 * docs/arquitectura.md): solo lo lee su dueño con la cuenta ACTIVA, ningún cliente
 * emite en él y fn_rt_sincronizar deja un aviso por (usuario, entidad, id) en cada
 * transacción. Los disparadores que emiten tienen sus propias pruebas.
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
});
