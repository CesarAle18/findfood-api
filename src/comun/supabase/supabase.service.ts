import { Injectable, Logger } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ConfigApp } from '../../config/configuracion';

export const BUCKETS = [
  'donaciones',
  'evidencias',
  'documentos-identidad',
] as const;
export type Bucket = (typeof BUCKETS)[number];

export interface DatosNuevoUsuario {
  email: string;
  password: string;
  appMetadata: Record<string, unknown>;
  userMetadata: Record<string, unknown>;
}

export class ErrorSupabase extends Error {
  constructor(
    mensaje: string,
    readonly codigo?: string,
    readonly status?: number,
  ) {
    super(mensaje);
  }
}

/**
 * Único punto que usa la service role key: administración de Auth (crear,
 * suspender y eliminar cuentas) y Storage (URLs firmadas). La API nunca escribe
 * el esquema auth directamente.
 */
@Injectable()
export class SupabaseService {
  private readonly logger = new Logger(SupabaseService.name);
  private readonly cliente: SupabaseClient;

  constructor(config: ConfigApp) {
    this.cliente = createClient(
      config.get('SUPABASE_URL'),
      config.get('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }

  // --- Auth -----------------------------------------------------------------

  async crearUsuario(datos: DatosNuevoUsuario): Promise<string> {
    const { data, error } = await this.cliente.auth.admin.createUser({
      email: datos.email,
      password: datos.password,
      email_confirm: true,
      app_metadata: datos.appMetadata,
      user_metadata: datos.userMetadata,
    });
    if (error || !data.user) {
      throw new ErrorSupabase(
        error?.message ?? 'No se pudo crear el usuario',
        error?.code,
        error?.status,
      );
    }
    return data.user.id;
  }

  async eliminarUsuario(id: string): Promise<void> {
    const { error } = await this.cliente.auth.admin.deleteUser(id);
    if (error) throw new ErrorSupabase(error.message, error.code, error.status);
  }

  /**
   * Cierra las sesiones: un usuario baneado no puede renovar su refresh token.
   * Los access token vigentes los bloquea el AuthGuard al leer usuario.estado.
   */
  async bloquearSesiones(id: string, hasta?: Date): Promise<void> {
    const horas = hasta
      ? Math.max(1, Math.ceil((hasta.getTime() - Date.now()) / 3_600_000))
      : 876_000; // ~100 años: indefinida
    const { error } = await this.cliente.auth.admin.updateUserById(id, {
      ban_duration: `${horas}h`,
    });
    if (error) throw new ErrorSupabase(error.message, error.code, error.status);
  }

  async desbloquearSesiones(id: string): Promise<void> {
    const { error } = await this.cliente.auth.admin.updateUserById(id, {
      ban_duration: 'none',
    });
    if (error) throw new ErrorSupabase(error.message, error.code, error.status);
  }

  // --- Storage --------------------------------------------------------------

  async urlSubida(
    bucket: Bucket,
    ruta: string,
  ): Promise<{ url: string; token: string }> {
    const { data, error } = await this.cliente.storage
      .from(bucket)
      .createSignedUploadUrl(ruta);
    if (error || !data) {
      throw new ErrorSupabase(error?.message ?? 'No se pudo firmar la subida');
    }
    return { url: data.signedUrl, token: data.token };
  }

  async urlLectura(
    bucket: Bucket,
    ruta: string,
    segundos: number,
  ): Promise<string | null> {
    const { data, error } = await this.cliente.storage
      .from(bucket)
      .createSignedUrl(ruta, segundos);
    if (error || !data) {
      this.logger.warn(
        { bucket, ruta, error: error?.message },
        'URL de lectura no firmada',
      );
      return null;
    }
    return data.signedUrl;
  }

  async existeObjeto(bucket: Bucket, ruta: string): Promise<boolean> {
    const { data, error } = await this.cliente.storage
      .from(bucket)
      .exists(ruta);
    if (error) return false;
    return data;
  }
}
