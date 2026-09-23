import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';
import type { CodigoRol, UsuarioAutenticado } from './tipos';

export const CLAVE_PUBLICA = 'auth:publica';
export const CLAVE_PERMITIR_PENDIENTE = 'auth:permitir-pendiente';
export const CLAVE_PERMITIR_PASSWORD_TEMPORAL =
  'auth:permitir-password-temporal';
export const CLAVE_ROLES = 'auth:roles';

/** Ruta sin autenticación (p. ej. /health). */
export const Publica = () => SetMetadata(CLAVE_PUBLICA, true);

/** Admite cuentas en PENDIENTE_CONFIRMACION (solo GET/PATCH /v1/me). */
export const PermitirPendiente = () =>
  SetMetadata(CLAVE_PERMITIR_PENDIENTE, true);

/** Admite cuentas con contraseña temporal sin cambiar (solo GET /v1/me). */
export const PermitirPasswordTemporal = () =>
  SetMetadata(CLAVE_PERMITIR_PASSWORD_TEMPORAL, true);

/** Exige al menos uno de los roles activos indicados. */
export const Roles = (...roles: CodigoRol[]) => SetMetadata(CLAVE_ROLES, roles);

export type PeticionAutenticada = Request & { usuario?: UsuarioAutenticado };

export const UsuarioActual = createParamDecorator(
  (_dato: unknown, ctx: ExecutionContext): UsuarioAutenticado => {
    const peticion = ctx.switchToHttp().getRequest<PeticionAutenticada>();
    if (!peticion.usuario) {
      throw new Error('UsuarioActual usado en una ruta @Publica()');
    }
    return peticion.usuario;
  },
);
