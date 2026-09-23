import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Problema } from '../http/problema';
import {
  CLAVE_PUBLICA,
  CLAVE_ROLES,
  type PeticionAutenticada,
} from './decoradores';
import type { CodigoRol } from './tipos';

/** Roles del usuario ∩ @Roles(...) del endpoint ≠ ∅. Sin @Roles, basta la autenticación. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const objetivos = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(CLAVE_PUBLICA, objetivos)) {
      return true;
    }
    const requeridos = this.reflector.getAllAndOverride<CodigoRol[]>(
      CLAVE_ROLES,
      objetivos,
    );
    if (!requeridos?.length) return true;

    const { usuario } = ctx.switchToHttp().getRequest<PeticionAutenticada>();
    if (usuario && requeridos.some((r) => usuario.roles.includes(r))) {
      return true;
    }
    throw new Problema(
      403,
      'rol-insuficiente',
      'Tu cuenta no tiene un rol autorizado para esta operación',
      undefined,
      { roles_requeridos: requeridos },
    );
  }
}
