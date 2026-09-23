import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles, UsuarioActual } from '../../comun/auth/decoradores';
import type { UsuarioAutenticado } from '../../comun/auth/tipos';
import { CalificacionDto, RespuestaConMotivoDto } from './asignacion.dto';
import { AsignacionService } from './asignacion.service';

@ApiTags('asignaciones')
@ApiBearerAuth()
@Controller('asignaciones')
export class AsignacionController {
  constructor(private readonly asignacion: AsignacionService) {}

  @Get('ofertas')
  @Roles('VOLUNTARIO')
  ofertas(@UsuarioActual() usuario: UsuarioAutenticado) {
    return this.asignacion.ofertas(usuario);
  }

  @Post(':id/aceptar')
  @Roles('VOLUNTARIO')
  @HttpCode(200)
  aceptar(
    @Param('id', ParseUUIDPipe) id: string,
    @UsuarioActual() usuario: UsuarioAutenticado,
  ) {
    return this.asignacion.aceptar(usuario, id);
  }

  @Post(':id/rechazar')
  @Roles('VOLUNTARIO')
  @HttpCode(200)
  rechazar(
    @Param('id', ParseUUIDPipe) id: string,
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Body() dto: RespuestaConMotivoDto,
  ) {
    return this.asignacion.rechazar(usuario, id, dto);
  }

  @Post(':id/abandonar')
  @Roles('VOLUNTARIO')
  @HttpCode(200)
  abandonar(
    @Param('id', ParseUUIDPipe) id: string,
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Body() dto: RespuestaConMotivoDto,
  ) {
    return this.asignacion.abandonar(usuario, id, dto);
  }

  @Post(':id/calificacion')
  @Roles('DONANTE', 'VOLUNTARIO')
  calificar(
    @Param('id', ParseUUIDPipe) id: string,
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Body() dto: CalificacionDto,
  ) {
    return this.asignacion.calificar(usuario, id, dto);
  }
}
