import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles, UsuarioActual } from '../../comun/auth/decoradores';
import type { UsuarioAutenticado } from '../../comun/auth/tipos';
import {
  ActualizarDonacionDto,
  CancelarDonacionDto,
  CrearDonacionDto,
  ListarDonacionesDto,
  ReasignarDonacionDto,
} from './donaciones.dto';
import { DonacionesService } from './donaciones.service';

@ApiTags('donaciones')
@ApiBearerAuth()
@Controller('donaciones')
export class DonacionesController {
  constructor(private readonly donaciones: DonacionesService) {}

  @Post()
  @Roles('DONANTE')
  crear(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Body() dto: CrearDonacionDto,
  ) {
    return this.donaciones.crear(usuario, dto);
  }

  @Get()
  @Roles('DONANTE', 'ADMIN', 'ASESOR_BANCO')
  listar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Query() filtro: ListarDonacionesDto,
  ) {
    return this.donaciones.listar(usuario, filtro);
  }

  /** Dueño, personal o el voluntario con la oferta o la asignación. */
  @Get(':id')
  detalle(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.donaciones.detalle(usuario, id);
  }

  @Patch(':id')
  @Roles('DONANTE')
  actualizar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ActualizarDonacionDto,
  ) {
    return this.donaciones.actualizar(usuario, id, dto);
  }

  @Post(':id/publicar')
  @Roles('DONANTE')
  @HttpCode(200)
  publicar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.donaciones.publicar(usuario, id);
  }

  @Post(':id/cancelar')
  @Roles('DONANTE', 'ADMIN')
  @HttpCode(200)
  cancelar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelarDonacionDto,
  ) {
    return this.donaciones.cancelar(usuario, id, dto);
  }

  @Post(':id/reasignar')
  @Roles('ADMIN', 'ASESOR_BANCO')
  @HttpCode(200)
  reasignar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasignarDonacionDto,
  ) {
    return this.donaciones.reasignar(usuario, id, dto.observacion);
  }

  @Get(':id/historial')
  @Roles('DONANTE', 'ADMIN', 'ASESOR_BANCO')
  historial(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.donaciones.historial(usuario, id);
  }

  @Get(':id/candidatos')
  @Roles('ADMIN', 'ASESOR_BANCO')
  candidatos(@Param('id', ParseUUIDPipe) id: string) {
    return this.donaciones.candidatos(id);
  }
}
