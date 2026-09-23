import type { estado_usuario } from '../../generated/prisma/client';

export const ROLES = [
  'DONANTE',
  'VOLUNTARIO',
  'ASESOR_BANCO',
  'ADMIN',
] as const;
export type CodigoRol = (typeof ROLES)[number];

export const ROLES_PERSONAL: readonly CodigoRol[] = ['ADMIN', 'ASESOR_BANCO'];

/** Lo que el AuthGuard deja en la petición tras validar token, estado y roles. */
export interface UsuarioAutenticado {
  id: string;
  email: string;
  nombres: string;
  estado: estado_usuario;
  debeCambiarPassword: boolean;
  roles: CodigoRol[];
}

export function tieneRol(
  usuario: UsuarioAutenticado,
  ...roles: CodigoRol[]
): boolean {
  return roles.some((r) => usuario.roles.includes(r));
}

export function esPersonal(usuario: UsuarioAutenticado): boolean {
  return tieneRol(usuario, ...ROLES_PERSONAL);
}
