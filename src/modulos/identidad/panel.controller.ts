import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  PermitirPasswordTemporal,
  PermitirPendiente,
  Publica,
  UsuarioActual,
} from '../../comun/auth/decoradores';
import type { UsuarioAutenticado } from '../../comun/auth/tipos';
import { RecuperarContrasenaDto } from './identidad.dto';
import { PanelService } from './panel.service';

@ApiTags('panel')
@Controller('panel')
export class PanelController {
  constructor(private readonly panel: PanelService) {}

  /**
   * Tras el login en Supabase Auth: 200 con el perfil si la cuenta es ADMIN o
   * ASESOR_BANCO; 403 acceso-panel-denegado en cualquier otro caso. Admite la
   * contraseña temporal (el perfil trae CAMBIAR_PASSWORD en `pendientes`) y
   * las cuentas pendientes, para que el rechazo sea siempre por el rol.
   */
  @Get('sesion')
  @ApiBearerAuth()
  @PermitirPendiente()
  @PermitirPasswordTemporal()
  sesion(@UsuarioActual() usuario: UsuarioAutenticado) {
    return this.panel.sesion(usuario);
  }

  /** Siempre 202: no revela si el correo existe ni si puede usar el panel. */
  @Post('recuperar-contrasena')
  @Publica()
  @HttpCode(202)
  async recuperarContrasena(@Body() dto: RecuperarContrasenaDto) {
    await this.panel.recuperarContrasena(dto.email);
    return {
      mensaje:
        'Si la cuenta puede usar el panel, enviamos un código de recuperación al correo',
    };
  }
}
