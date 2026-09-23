import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  PermitirPasswordTemporal,
  PermitirPendiente,
  Roles,
  UsuarioActual,
} from '../../comun/auth/decoradores';
import type { UsuarioAutenticado } from '../../comun/auth/tipos';
import {
  ActualizarPerfilDto,
  DisponibilidadDto,
  EstadoVoluntarioDto,
  RegistrarDispositivoDto,
  SolicitudVoluntarioDto,
  UbicacionVoluntarioDto,
} from './identidad.dto';
import { IdentidadService } from './identidad.service';
import { VoluntarioService } from './voluntario.service';

@ApiTags('identidad')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(private readonly identidad: IdentidadService) {}

  @Get()
  @PermitirPendiente()
  @PermitirPasswordTemporal()
  perfil(@UsuarioActual() usuario: UsuarioAutenticado) {
    return this.identidad.perfil(usuario);
  }

  @Patch()
  @PermitirPendiente()
  actualizar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Body() dto: ActualizarPerfilDto,
  ) {
    return this.identidad.actualizarPerfil(usuario, dto);
  }

  @Get('impacto')
  @Roles('DONANTE', 'VOLUNTARIO')
  impacto(@UsuarioActual() usuario: UsuarioAutenticado) {
    return this.identidad.impacto(usuario);
  }

  @Post('dispositivos')
  @Roles('DONANTE', 'VOLUNTARIO')
  registrarDispositivo(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Body() dto: RegistrarDispositivoDto,
  ) {
    return this.identidad.registrarDispositivo(usuario, dto);
  }

  @Delete('dispositivos/:id')
  @Roles('DONANTE', 'VOLUNTARIO')
  @HttpCode(204)
  async eliminarDispositivo(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.identidad.eliminarDispositivo(usuario, id);
  }
}

@ApiTags('voluntario')
@ApiBearerAuth()
@Controller('voluntario')
export class VoluntarioController {
  constructor(private readonly voluntarios: VoluntarioService) {}

  @Post('solicitud')
  @Roles('DONANTE')
  solicitar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Body() dto: SolicitudVoluntarioDto,
    @Req() peticion: Request,
  ) {
    return this.voluntarios.solicitar(usuario, dto, peticion);
  }

  @Put('disponibilidad')
  @Roles('VOLUNTARIO')
  disponibilidad(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Body() dto: DisponibilidadDto,
  ) {
    return this.voluntarios.reemplazarDisponibilidad(usuario, dto);
  }

  @Patch('estado')
  @Roles('VOLUNTARIO')
  estado(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Body() dto: EstadoVoluntarioDto,
  ) {
    return this.voluntarios.cambiarDisponible(usuario, dto.disponible);
  }

  @Post('ubicacion')
  @Roles('VOLUNTARIO')
  @HttpCode(200)
  ubicacion(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Body() dto: UbicacionVoluntarioDto,
  ) {
    return this.voluntarios.registrarUbicacion(usuario, dto);
  }
}
