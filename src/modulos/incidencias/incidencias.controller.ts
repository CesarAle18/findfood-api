import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles, UsuarioActual } from '../../comun/auth/decoradores';
import type { UsuarioAutenticado } from '../../comun/auth/tipos';
import {
  CrearIncidenciaDto,
  ListarIncidenciasDto,
  ResolverIncidenciaDto,
} from './incidencias.dto';
import { IncidenciasService } from './incidencias.service';

@ApiTags('incidencias')
@ApiBearerAuth()
@Controller('incidencias')
export class IncidenciasController {
  constructor(private readonly incidencias: IncidenciasService) {}

  @Post()
  crear(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Body() dto: CrearIncidenciaDto,
  ) {
    return this.incidencias.crear(usuario, dto);
  }

  @Get()
  listar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Query() filtro: ListarIncidenciasDto,
  ) {
    return this.incidencias.listar(usuario, filtro);
  }

  @Get(':id')
  detalle(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.incidencias.detalle(usuario, id);
  }

  @Post(':id/revisar')
  @Roles('ADMIN', 'ASESOR_BANCO')
  @HttpCode(200)
  revisar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.incidencias.revisar(usuario, id);
  }

  @Post(':id/resolver')
  @Roles('ADMIN')
  @HttpCode(200)
  resolver(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolverIncidenciaDto,
  ) {
    return this.incidencias.resolver(usuario, id, dto.resolucion);
  }
}
