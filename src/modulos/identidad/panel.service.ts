import { Injectable, Logger } from '@nestjs/common';
import {
  esPersonal,
  ROLES_PERSONAL,
  type UsuarioAutenticado,
} from '../../comun/auth/tipos';
import { prohibido } from '../../comun/http/problema';
import { PrismaService } from '../../comun/prisma/prisma.service';
import { SupabaseService } from '../../comun/supabase/supabase.service';
import { IdentidadService } from './identidad.service';

/**
 * Acceso al panel web: solo ADMIN y ASESOR_BANCO. Donantes y voluntarios usan
 * la app móvil, que sigue autenticándose directo contra Supabase Auth.
 */
@Injectable()
export class PanelService {
  private readonly logger = new Logger(PanelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
    private readonly identidad: IdentidadService,
  ) {}

  /** El panel la llama justo después del login; si responde 403, cierra la sesión. */
  async sesion(usuario: UsuarioAutenticado) {
    if (!esPersonal(usuario)) {
      throw prohibido(
        'acceso-panel-denegado',
        'No puedes iniciar sesión en el panel web: es solo para administradores y asesores del banco',
      );
    }
    return this.identidad.perfil(usuario);
  }

  /**
   * Envía el código solo a cuentas ACTIVAS con rol ADMIN o ASESOR_BANCO. La
   * respuesta es la misma en todos los casos para no revelar qué correos
   * existen ni qué rol tienen.
   */
  async recuperarContrasena(email: string): Promise<void> {
    const habilitada = await this.prisma.usuario.count({
      where: {
        email,
        deleted_at: null,
        estado: 'ACTIVO',
        usuario_rol_usuario_rol_usuario_idTousuario: {
          some: {
            activo: true,
            rol: { activo: true, codigo: { in: [...ROLES_PERSONAL] } },
          },
        },
      },
    });
    if (!habilitada) {
      this.logger.log('Recuperación omitida: la cuenta no puede usar el panel');
      return;
    }
    try {
      await this.supabase.enviarCodigoRecuperacion(email);
    } catch (err) {
      this.logger.warn({ err }, 'Supabase no envió el código de recuperación');
    }
  }
}
