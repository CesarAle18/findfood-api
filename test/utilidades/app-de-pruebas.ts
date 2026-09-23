import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { SignJWT } from 'jose';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import {
  ErrorSupabase,
  SupabaseService,
} from '../../src/comun/supabase/supabase.service';
import { configurarApp } from '../../src/configurar-app';
import {
  type MensajePush,
  ProveedorPush,
  type ResultadoPush,
} from '../../src/modulos/notificaciones/proveedor-push';
import { BASE_PRUEBAS, urlBase } from '../configuracion/base-de-pruebas';

/**
 * Supabase simulado: las cuentas se crean insertando en auth.users como lo
 * haría GoTrue, así los disparadores reales del DDL (§16) crean el perfil.
 */
export class SupabaseFalso {
  sesionesBloqueadas = new Set<string>();

  constructor(private readonly sql: Client) {}

  async crearUsuario(d: {
    email: string;
    password: string;
    appMetadata: Record<string, unknown>;
    userMetadata: Record<string, unknown>;
  }): Promise<string> {
    const existe = await this.sql.query(
      'SELECT 1 FROM auth.users WHERE email = $1',
      [d.email],
    );
    if (existe.rowCount)
      throw new ErrorSupabase('User already registered', 'email_exists', 422);
    const { rows } = await this.sql.query<{ id: string }>(
      `INSERT INTO auth.users (email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
       VALUES ($1, $2, now(), $3, $4) RETURNING id`,
      [d.email, `hash:${d.password}`, d.appMetadata, d.userMetadata],
    );
    return rows[0].id;
  }

  async eliminarUsuario(id: string): Promise<void> {
    await this.sql.query('DELETE FROM auth.users WHERE id = $1', [id]);
  }

  async bloquearSesiones(id: string): Promise<void> {
    this.sesionesBloqueadas.add(id);
  }

  async desbloquearSesiones(id: string): Promise<void> {
    this.sesionesBloqueadas.delete(id);
  }

  async urlSubida(bucket: string, ruta: string) {
    return {
      url: `https://storage.prueba/upload/${bucket}/${ruta}?token=t`,
      token: 't',
    };
  }

  async urlLectura(bucket: string, ruta: string, segundos: number) {
    return `https://storage.prueba/object/${bucket}/${ruta}?expira=${segundos}`;
  }

  async existeObjeto(): Promise<boolean> {
    return true;
  }
}

export class PushFalso extends ProveedorPush {
  enviados: MensajePush[] = [];
  tokensInvalidos = new Set<string>();

  async enviar(mensajes: MensajePush[]): Promise<ResultadoPush[]> {
    this.enviados.push(...mensajes);
    return mensajes.map((m) =>
      this.tokensInvalidos.has(m.token)
        ? {
            ok: false,
            error: 'DeviceNotRegistered: token',
            tokenInvalido: true,
          }
        : { ok: true },
    );
  }
}

export interface Cuenta {
  id: string;
  email: string;
  token: string;
}

export interface OpcionesCuenta {
  email?: string;
  nombres?: string;
  telefono?: string | null;
  confirmado?: boolean;
  appMeta?: Record<string, unknown>;
  userMeta?: Record<string, unknown>;
}

export class ContextoPruebas {
  app: INestApplication<App>;
  /** El servidor escucha una sola vez: supertest no abre y cierra un puerto por petición. */
  url: string;
  sql: Client;
  supabase: SupabaseFalso;
  push = new PushFalso();

  static async crear(): Promise<ContextoPruebas> {
    const ctx = new ContextoPruebas();
    ctx.sql = new Client({ connectionString: urlBase(BASE_PRUEBAS) });
    await ctx.sql.connect();
    ctx.supabase = new SupabaseFalso(ctx.sql);
    const modulo = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SupabaseService)
      .useValue(ctx.supabase)
      .overrideProvider(ProveedorPush)
      .useValue(ctx.push)
      .compile();
    const app = modulo.createNestApplication<NestExpressApplication>({
      logger: false,
    });
    configurarApp(app);
    await app.listen(0, '127.0.0.1');
    ctx.url = await app.getUrl();
    ctx.app = app as unknown as INestApplication<App>;
    return ctx;
  }

  async cerrar(): Promise<void> {
    await this.app.close();
    await this.sql.end();
  }

  get http() {
    return request(this.url);
  }

  /** Petición autenticada. */
  como(cuenta: Cuenta) {
    const servidor = this.url;
    const auth = (r: request.Test) =>
      r.set('Authorization', `Bearer ${cuenta.token}`);
    return {
      get: (url: string) => auth(request(servidor).get(url)),
      post: (url: string) => auth(request(servidor).post(url)),
      put: (url: string) => auth(request(servidor).put(url)),
      patch: (url: string) => auth(request(servidor).patch(url)),
      delete: (url: string) => auth(request(servidor).delete(url)),
    };
  }

  async token(
    sub: string,
    opciones: { secreto?: string; vence?: string } = {},
  ): Promise<string> {
    return new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(sub)
      .setIssuer('http://supabase.prueba/auth/v1')
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime(opciones.vence ?? '1h')
      .sign(
        new TextEncoder().encode(
          opciones.secreto ?? process.env.SUPABASE_JWT_SECRET,
        ),
      );
  }

  /** Simula un alta en GoTrue (signUp o admin). */
  async cuenta(o: OpcionesCuenta = {}): Promise<Cuenta> {
    const email = o.email ?? `u-${randomUUID().slice(0, 8)}@prueba.co`;
    const telefono = o.telefono === undefined ? '+573001112233' : o.telefono;
    const { rows } = await this.sql.query<{ id: string }>(
      `INSERT INTO auth.users (email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
       VALUES ($1, 'hash', $2, $3, $4) RETURNING id`,
      [
        email,
        o.confirmado === false ? null : new Date(),
        o.appMeta ?? { provider: 'email' },
        {
          nombres: o.nombres ?? 'Persona',
          telefono,
          acepto_terminos: true,
          ...o.userMeta,
        },
      ],
    );
    return { id: rows[0].id, email, token: await this.token(rows[0].id) };
  }

  admin(): Promise<Cuenta> {
    return this.cuenta({ nombres: 'Admin', appMeta: { rol: 'ADMIN' } });
  }

  asesor(): Promise<Cuenta> {
    return this.cuenta({ nombres: 'Asesor', appMeta: { rol: 'ASESOR_BANCO' } });
  }

  async ruta(cuenta: Cuenta, proposito: string): Promise<string> {
    const r = await this.como(cuenta)
      .post('/v1/evidencias/upload-url')
      .send({ proposito, extension: 'jpg' })
      .expect(200);
    return r.body.ruta as string;
  }

  /** Voluntario aprobado, disponible toda la semana, con base en `base`. */
  async voluntario(
    admin: Cuenta,
    base: { lat: number; lng: number },
    extra: Partial<{
      capacidad_carga_kg: number;
      tiene_refrigeracion: boolean;
      placa: string;
      radio_cobertura_km: number;
    }> = {},
  ): Promise<Cuenta & { voluntarioId: string }> {
    const persona = await this.cuenta({ nombres: 'Vol' });
    const solicitud = await this.como(persona)
      .post('/v1/voluntario/solicitud')
      .send({
        tipo_vehiculo_id: 3,
        placa_vehiculo:
          extra.placa ??
          `V${randomUUID().replaceAll('-', '').slice(0, 5).toUpperCase()}`,
        url_foto_vehiculo: await this.ruta(persona, 'VEHICULO'),
        capacidad_carga_kg: extra.capacidad_carga_kg ?? 500,
        tiene_refrigeracion: extra.tiene_refrigeracion ?? false,
        fecha_nacimiento: '1990-05-10',
        ubicacion_base: base,
        radio_cobertura_km: extra.radio_cobertura_km ?? 20,
        documento_frente: await this.ruta(persona, 'DOCUMENTO_IDENTIDAD'),
      })
      .expect(201);
    await this.como(admin)
      .post(
        `/v1/admin/verificaciones/${solicitud.body.verificacion.id}/aprobar`,
      )
      .expect(200);
    await this.como(persona)
      .put('/v1/voluntario/disponibilidad')
      .send({
        franjas: [0, 1, 2, 3, 4, 5, 6].map((dia) => ({
          dia_semana: dia,
          hora_inicio: '00:00',
          hora_fin: '23:59',
        })),
      })
      .expect(200);
    await this.como(persona)
      .patch('/v1/voluntario/estado')
      .send({ disponible: true })
      .expect(200);
    return { ...persona, voluntarioId: solicitud.body.voluntario_id as string };
  }
}

/** Ventana de recogida que empieza ya y dura `horas`. */
export function ventana(horas = 4, desdeMin = 1) {
  const inicio = new Date(Date.now() + desdeMin * 60_000);
  return {
    ventana_recogida_inicio: inicio.toISOString(),
    ventana_recogida_fin: new Date(
      inicio.getTime() + horas * 3_600_000,
    ).toISOString(),
  };
}
