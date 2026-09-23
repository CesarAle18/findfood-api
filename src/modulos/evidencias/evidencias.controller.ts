import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UsuarioActual } from '../../comun/auth/decoradores';
import type { UsuarioAutenticado } from '../../comun/auth/tipos';
import { ArchivosService } from './archivos.service';
import {
  PadreEvidenciaDto,
  RegistrarEvidenciaDto,
  SolicitarSubidaDto,
} from './evidencias.dto';
import { EvidenciasService } from './evidencias.service';

@ApiTags('evidencias')
@ApiBearerAuth()
@Controller('evidencias')
export class EvidenciasController {
  constructor(
    private readonly evidencias: EvidenciasService,
    private readonly archivos: ArchivosService,
  ) {}

  /** URL firmada para subir directo a Storage; la ruta la decide la API (§8.5). */
  @Post('upload-url')
  @HttpCode(200)
  urlSubida(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Body() dto: SolicitarSubidaDto,
  ) {
    return this.archivos.emitirSubida(usuario.id, dto.proposito, dto.extension);
  }

  @Post()
  registrar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Body() dto: RegistrarEvidenciaDto,
  ) {
    return this.evidencias.registrar(usuario, dto);
  }

  @Get()
  listar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Query() filtro: PadreEvidenciaDto,
  ) {
    return this.evidencias.listar(usuario, filtro);
  }
}
