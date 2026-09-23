import { ContextoPruebas } from './utilidades/app-de-pruebas';

/** Guards globales (§5.2) y reglas de identidad del DDL v3 (§13.2, §14). */
describe('Autenticación y autorización', () => {
  let ctx: ContextoPruebas;

  beforeAll(async () => {
    ctx = await ContextoPruebas.crear();
  });

  afterAll(async () => {
    await ctx.cerrar();
  });

  describe('AuthGuard', () => {
    it('sin token responde 401 no-autenticado', async () => {
      const r = await ctx.http.get('/v1/me').expect(401);
      expect(r.body.type).toBe('no-autenticado');
    });

    it('rechaza un token firmado con otro secreto', async () => {
      const cuenta = await ctx.cuenta();
      const falso = await ctx.token(cuenta.id, {
        secreto: 'otro-secreto-de-al-menos-16',
      });
      const r = await ctx.http
        .get('/v1/me')
        .set('Authorization', `Bearer ${falso}`)
        .expect(401);
      expect(r.body.type).toBe('token-invalido');
    });

    it('rechaza un token vencido', async () => {
      const cuenta = await ctx.cuenta();
      const vencido = await ctx.token(cuenta.id, { vence: '-1m' });
      await ctx.http
        .get('/v1/me')
        .set('Authorization', `Bearer ${vencido}`)
        .expect(401);
    });

    it('un token válido de un usuario sin perfil responde 403', async () => {
      const token = await ctx.token('00000000-0000-4000-8000-000000000000');
      const r = await ctx.http
        .get('/v1/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      expect(r.body.type).toBe('cuenta-inexistente');
    });
  });

  describe('Alta desde la app (disparador §16.1)', () => {
    it('todo registro propio nace DONANTE con su fila en donante', async () => {
      const cuenta = await ctx.cuenta();
      const r = await ctx.como(cuenta).get('/v1/me').expect(200);
      expect(r.body.roles).toEqual(['DONANTE']);
      expect(r.body.estado).toBe('ACTIVO');
      expect(r.body.donante).not.toBeNull();
    });

    it('[crítico v2] el rol en user_metadata se ignora: nadie se registra como ADMIN', async () => {
      const cuenta = await ctx.cuenta({
        userMeta: { rol: 'ADMIN', password_temporal: true },
      });
      const r = await ctx.como(cuenta).get('/v1/me').expect(200);
      expect(r.body.roles).toEqual(['DONANTE']);
      expect(r.body.debe_cambiar_password).toBe(false);
      await ctx.como(cuenta).get('/v1/admin/usuarios').expect(403);
    });
  });

  describe('Estados de la cuenta', () => {
    it('sin teléfono queda PENDIENTE: solo GET/PATCH /v1/me', async () => {
      const cuenta = await ctx.cuenta({ telefono: null });
      const me = await ctx.como(cuenta).get('/v1/me').expect(200);
      expect(me.body.estado).toBe('PENDIENTE_CONFIRMACION');
      expect(me.body.pendientes).toContain('TELEFONO');

      const bloqueada = await ctx
        .como(cuenta)
        .get('/v1/donaciones')
        .expect(403);
      expect(bloqueada.body.type).toBe('cuenta-pendiente');

      // Completar el perfil (registro con Google) activa la cuenta.
      const r = await ctx
        .como(cuenta)
        .patch('/v1/me')
        .send({ telefono: '300 123 4567' })
        .expect(200);
      expect(r.body.estado).toBe('ACTIVO');
      expect(r.body.telefono).toBe('+573001234567');
      await ctx.como(cuenta).get('/v1/donaciones').expect(200);
    });

    it('sin correo confirmado sigue PENDIENTE aunque tenga teléfono, hasta que Auth lo confirma', async () => {
      const cuenta = await ctx.cuenta({ confirmado: false });
      await ctx.como(cuenta).get('/v1/donaciones').expect(403);
      await ctx.sql.query(
        'UPDATE auth.users SET email_confirmed_at = now() WHERE id = $1',
        [cuenta.id],
      );
      await ctx.como(cuenta).get('/v1/donaciones').expect(200);
    });

    it('valida el formato del teléfono', async () => {
      const cuenta = await ctx.cuenta({ telefono: null });
      const r = await ctx
        .como(cuenta)
        .patch('/v1/me')
        .send({ telefono: '12345' })
        .expect(400);
      expect(r.body.type).toBe('validacion');
    });

    it('rechaza campos no declarados en el DTO (forbidNonWhitelisted)', async () => {
      const cuenta = await ctx.cuenta();
      const r = await ctx
        .como(cuenta)
        .patch('/v1/me')
        .send({ estado: 'ACTIVO' })
        .expect(400);
      expect(r.body.type).toBe('validacion');
    });
  });

  describe('Asesores y contraseña temporal', () => {
    it('el alta del admin crea un ASESOR_BANCO que solo puede ver /me hasta cambiar la contraseña', async () => {
      const admin = await ctx.admin();
      const r = await ctx
        .como(admin)
        .post('/v1/admin/asesores')
        .send({
          email: 'Asesora@Banco.co',
          nombres: 'Ana',
          telefono: '3109876543',
        })
        .expect(201);
      expect(r.body.correo_enviado).toBe(false);
      expect(r.body.password_temporal).toHaveLength(14);

      const asesor = {
        id: r.body.id as string,
        email: r.body.email as string,
        token: await ctx.token(r.body.id),
      };
      const me = await ctx.como(asesor).get('/v1/me').expect(200);
      expect(me.body.roles).toEqual(['ASESOR_BANCO']);
      expect(me.body.debe_cambiar_password).toBe(true);
      expect(me.body.estado).toBe('ACTIVO');

      const bloqueo = await ctx.como(asesor).get('/v1/almacenes').expect(403);
      expect(bloqueo.body.type).toBe('cambio-password-requerido');
      await ctx
        .como(asesor)
        .patch('/v1/me')
        .send({ nombres: 'Ana María' })
        .expect(403);

      // El cambio ocurre en Supabase Auth; el disparador §16.4 apaga la marca.
      await ctx.sql.query(
        `UPDATE auth.users SET encrypted_password = 'nuevo' WHERE id = $1`,
        [asesor.id],
      );
      await ctx.como(asesor).get('/v1/almacenes').expect(200);
    });

    it('un correo ya registrado responde 409', async () => {
      const admin = await ctx.admin();
      const existente = await ctx.cuenta();
      const r = await ctx
        .como(admin)
        .post('/v1/admin/asesores')
        .send({
          email: existente.email,
          nombres: 'Otro',
          telefono: '3109876543',
        })
        .expect(409);
      expect(r.body.type).toBe('email-registrado');
    });
  });

  describe('RolesGuard', () => {
    it('interseca roles: un DONANTE no entra a rutas de ADMIN ni de VOLUNTARIO', async () => {
      const donante = await ctx.cuenta();
      const r = await ctx
        .como(donante)
        .get('/v1/asignaciones/ofertas')
        .expect(403);
      expect(r.body).toMatchObject({
        type: 'rol-insuficiente',
        roles_requeridos: ['VOLUNTARIO'],
      });
      await ctx.como(donante).get('/v1/admin/parametros').expect(403);
    });

    it('el personal no puede crear donaciones', async () => {
      const asesor = await ctx.asesor();
      await ctx.como(asesor).post('/v1/donaciones').send({}).expect(403);
    });

    it('[DDL §17.1] roles internos y externos no coexisten en una cuenta', async () => {
      const donante = await ctx.cuenta();
      await expect(
        ctx.sql.query(
          `INSERT INTO usuario_rol (usuario_id, rol_id)
           SELECT $1, id FROM rol WHERE codigo = 'ADMIN'`,
          [donante.id],
        ),
      ).rejects.toThrow(/incompatibles/);
    });
  });

  describe('Suspensión', () => {
    it('surte efecto en la siguiente petición y se revierte al reactivar', async () => {
      const admin = await ctx.admin();
      const donante = await ctx.cuenta();
      await ctx.como(donante).get('/v1/me').expect(200);

      await ctx
        .como(admin)
        .post(`/v1/admin/usuarios/${donante.id}/suspender`)
        .send({ descripcion: 'Uso indebido de la plataforma' })
        .expect(200);
      expect(ctx.supabase.sesionesBloqueadas.has(donante.id)).toBe(true);
      const r = await ctx.como(donante).get('/v1/me').expect(403);
      expect(r.body.type).toBe('cuenta-suspendida');

      await ctx
        .como(admin)
        .post(`/v1/admin/usuarios/${donante.id}/reactivar`)
        .expect(200);
      expect(ctx.supabase.sesionesBloqueadas.has(donante.id)).toBe(false);
      await ctx.como(donante).get('/v1/me').expect(200);
    });

    it('el admin no puede suspenderse a sí mismo', async () => {
      const admin = await ctx.admin();
      await ctx
        .como(admin)
        .post(`/v1/admin/usuarios/${admin.id}/suspender`)
        .send({ descripcion: 'Prueba de auto suspensión' })
        .expect(422);
    });
  });

  describe('Superficie de Supabase (§13.1, prueba P5)', () => {
    it('toda tabla de public tiene RLS y la política pol_app_backend', async () => {
      const { rows } = await ctx.sql.query<{ tabla: string }>(`
        SELECT c.relname AS tabla
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
           AND (NOT c.relrowsecurity
                OR NOT EXISTS (SELECT 1 FROM pg_policy p
                                WHERE p.polrelid = c.oid AND p.polname = 'pol_app_backend'))`);
      expect(rows).toEqual([]);
    });

    it('anon y authenticated no tienen privilegios sobre tablas ni funciones propias', async () => {
      const tablas = await ctx.sql.query(`
        SELECT table_name FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND grantee IN ('anon','authenticated')`);
      expect(tablas.rows).toEqual([]);
      const funciones = await ctx.sql.query<{ proname: string }>(`
        SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname LIKE 'fn\\_%'
           AND has_function_privilege('anon', p.oid, 'EXECUTE')`);
      expect(funciones.rows).toEqual([]);
    });
  });
});
