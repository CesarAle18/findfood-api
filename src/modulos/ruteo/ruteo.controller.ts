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
  ConfirmarParadaDto,
  CrearRutaDto,
  ListarRutasDto,
  LlegadaParadaDto,
  ParadaFallidaDto,
  SeguimientoDto,
} from './ruteo.dto';
import { RuteoService } from './ruteo.service';
import { SeguimientoService } from './seguimiento.service';

@ApiTags('ruteo')
@ApiBearerAuth()
@Controller('rutas')
export class RutasController {
  constructor(
    private readonly ruteo: RuteoService,
    private readonly seguimientos: SeguimientoService,
  ) {}

  @Post()
  @Roles('VOLUNTARIO', 'ASESOR_BANCO')
  crear(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Body() dto: CrearRutaDto,
  ) {
    return this.ruteo.crear(usuario, dto);
  }

  @Get()
  @Roles('VOLUNTARIO', 'ASESOR_BANCO', 'ADMIN')
  listar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Query() filtro: ListarRutasDto,
  ) {
    return this.ruteo.listar(usuario, filtro);
  }

  @Get(':id')
  @Roles('VOLUNTARIO', 'ASESOR_BANCO', 'ADMIN')
  detalle(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ruteo.detalle(usuario, id);
  }

  /** Camino y llegada estimada a la siguiente parada de una ruta EN_CURSO. */
  @Get(':id/seguimiento')
  @Roles('VOLUNTARIO', 'ASESOR_BANCO', 'ADMIN')
  seguimiento(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() dto: SeguimientoDto,
  ) {
    return this.seguimientos.seguimiento(usuario, id, dto);
  }

  @Post(':id/iniciar')
  @Roles('VOLUNTARIO', 'ASESOR_BANCO')
  @HttpCode(200)
  iniciar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ruteo.iniciar(usuario, id);
  }

  @Post(':id/cancelar')
  @Roles('VOLUNTARIO', 'ASESOR_BANCO', 'ADMIN')
  @HttpCode(200)
  cancelar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ruteo.cancelar(usuario, id);
  }
}

@ApiTags('ruteo')
@ApiBearerAuth()
@Controller('paradas')
export class ParadasController {
  constructor(private readonly ruteo: RuteoService) {}

  @Post(':id/llegada')
  @Roles('VOLUNTARIO', 'ASESOR_BANCO')
  @HttpCode(200)
  llegada(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LlegadaParadaDto,
  ) {
    return this.ruteo.llegada(usuario, id, dto);
  }

  @Post(':id/confirmar')
  @Roles('VOLUNTARIO', 'ASESOR_BANCO')
  @HttpCode(200)
  confirmar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmarParadaDto,
  ) {
    return this.ruteo.confirmar(usuario, id, dto);
  }

  @Post(':id/fallida')
  @Roles('VOLUNTARIO', 'ASESOR_BANCO')
  @HttpCode(200)
  fallida(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ParadaFallidaDto,
  ) {
    return this.ruteo.fallida(usuario, id, dto);
  }
}

/**
 * Vive en ruteo y no en donaciones: RuteoModule ya importa DonacionesModule, así que
 * ponerlo allá crearía una dependencia circular.
 */
@ApiTags('ruteo')
@ApiBearerAuth()
@Controller('donaciones')
export class SeguimientoDonacionController {
  constructor(private readonly seguimientos: SeguimientoService) {}

  /**
   * Seguimiento en vivo para el donante (API-06): fase, posición reciente del voluntario
   * y llegada estimada a su punto o al banco, hasta que la donación se entrega.
   */
  @Get(':id/seguimiento')
  @Roles('DONANTE', 'ADMIN', 'ASESOR_BANCO')
  seguimiento(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.seguimientos.seguimientoDonacion(usuario, id);
  }
}
