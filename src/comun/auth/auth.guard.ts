import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { Problema } from '../http/problema';
import {
  CLAVE_PERMITIR_PASSWORD_TEMPORAL,
  CLAVE_PERMITIR_PENDIENTE,
  CLAVE_PUBLICA,
  type PeticionAutenticada,
} from './decoradores';
import { type CodigoRol, ROLES } from './tipos';
import { VerificadorJwt } from './verificador-jwt.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** ultimo_acceso_at se actualiza como mucho una vez por este intervalo. */
const INTERVALO_ULTIMO_ACCESO_MS = 5 * 60_000;

/**
 * Guard global (§5.2). Consulta usuario y roles en CADA petición para que una
 * suspensión o un retiro de rol surtan efecto sin esperar a que venza el token.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly verificador: VerificadorJwt,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const marca = <T>(clave: string) =>
      this.reflector.getAllAndOverride<T>(clave, [
        ctx.getHandler(),
        ctx.getClass(),
      ]);
    if (marca<boolean>(CLAVE_PUBLICA)) return true;

    const peticion = ctx.switchToHttp().getRequest<PeticionAutenticada>();
    const [esquema, token] = (peticion.headers.authorization ?? '').split(' ');
    if (esquema?.toLowerCase() !== 'bearer' || !token) {
      throw new Problema(401, 'no-autenticado', 'Falta el token de acceso');
    }

    let sub: string;
    try {
      sub = await this.verificador.verificar(token);
    } catch {
      throw new Problema(
        401,
        'token-invalido',
        'El token de acceso no es válido o venció',
      );
    }
    if (!UUID.test(sub)) {
      throw new Problema(
        401,
        'token-invalido',
        'El token no identifica un usuario',
      );
    }

    const usuario = await this.prisma.usuario.findUnique({
      where: { id: sub },
      select: {
        id: true,
        email: true,
        nombres: true,
        estado: true,
        debe_cambiar_password: true,
        deleted_at: true,
        ultimo_acceso_at: true,
        usuario_rol_usuario_rol_usuario_idTousuario: {
          where: { activo: true, rol: { activo: true } },
          select: { rol: { select: { codigo: true } } },
        },
      },
    });
    if (!usuario || usuario.deleted_at) {
      throw new Problema(
        403,
        'cuenta-inexistente',
        'La cuenta no existe o fue eliminada',
      );
    }

    switch (usuario.estado) {
      case 'SUSPENDIDO':
        throw new Problema(
          403,
          'cuenta-suspendida',
          'La cuenta está suspendida',
        );
      case 'INACTIVO':
        throw new Problema(403, 'cuenta-inactiva', 'La cuenta está inactiva');
      case 'PENDIENTE_CONFIRMACION':
        if (!marca<boolean>(CLAVE_PERMITIR_PENDIENTE)) {
          throw new Problema(
            403,
            'cuenta-pendiente',
            'Completa tu perfil (teléfono) y confirma tu correo para continuar',
          );
        }
        break;
      case 'ACTIVO':
        break;
    }

    if (
      usuario.debe_cambiar_password &&
      !marca<boolean>(CLAVE_PERMITIR_PASSWORD_TEMPORAL)
    ) {
      throw new Problema(
        403,
        'cambio-password-requerido',
        'Debes cambiar la contraseña temporal antes de continuar',
      );
    }

    peticion.usuario = {
      id: usuario.id,
      email: usuario.email,
      nombres: usuario.nombres,
      estado: usuario.estado,
      debeCambiarPassword: usuario.debe_cambiar_password,
      roles: usuario.usuario_rol_usuario_rol_usuario_idTousuario
        .map((ur) => ur.rol.codigo)
        .filter((c): c is CodigoRol =>
          (ROLES as readonly string[]).includes(c),
        ),
    };

    if (
      !usuario.ultimo_acceso_at ||
      Date.now() - usuario.ultimo_acceso_at.getTime() >
        INTERVALO_ULTIMO_ACCESO_MS
    ) {
      this.prisma.usuario
        .update({
          where: { id: usuario.id },
          data: { ultimo_acceso_at: new Date() },
        })
        .catch((err: unknown) =>
          this.logger.warn({ err }, 'No se pudo actualizar ultimo_acceso_at'),
        );
    }
    return true;
  }
}
