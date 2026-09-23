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
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import type { Request } from 'express';
import { Roles, UsuarioActual } from '../../comun/auth/decoradores';
import type { UsuarioAutenticado } from '../../comun/auth/tipos';
import { AlmacenesService } from './almacenes.service';
import { DistribucionesService } from './distribuciones.service';
import {
  ActualizarAlmacenDto,
  AjusteLoteDto,
  AtenderAlertaDto,
  CrearAlmacenDto,
  CrearDistribucionDto,
  CrearRecepcionDto,
  ListarDistribucionesDto,
  ListarLotesDto,
  ListarRecepcionesDto,
  RangoFechasDto,
} from './inventario.dto';
import { KpisService } from './kpis.service';
import { LotesService } from './lotes.service';
import { RecepcionesService } from './recepciones.service';

@ApiTags('inventario')
@ApiBearerAuth()
@Controller('almacenes')
@Roles('ASESOR_BANCO', 'ADMIN')
export class AlmacenesController {
  constructor(private readonly almacenes: AlmacenesService) {}

  @Get()
  listar() {
    return this.almacenes.listar();
  }

  @Post()
  @Roles('ADMIN')
  crear(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Body() dto: CrearAlmacenDto,
    @Req() peticion: Request,
  ) {
    return this.almacenes.crear(dto, usuario.id, peticion);
  }

  @Patch(':id')
  actualizar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ActualizarAlmacenDto,
    @Req() peticion: Request,
  ) {
    return this.almacenes.actualizar(id, dto, usuario.id, peticion);
  }
}

@ApiTags('inventario')
@ApiBearerAuth()
@Controller('recepciones')
export class RecepcionesController {
  constructor(private readonly recepciones: RecepcionesService) {}

  @Post()
  @Roles('ASESOR_BANCO')
  crear(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Body() dto: CrearRecepcionDto,
  ) {
    return this.recepciones.crear(usuario, dto);
  }

  @Get()
  @Roles('ASESOR_BANCO', 'ADMIN')
  listar(@Query() filtro: ListarRecepcionesDto) {
    return this.recepciones.listar(filtro);
  }

  @Get(':id')
  @Roles('ASESOR_BANCO', 'ADMIN')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.recepciones.detalle(id);
  }
}

@ApiTags('inventario')
@ApiBearerAuth()
@Controller('inventario/lotes')
export class LotesController {
  constructor(private readonly lotes: LotesService) {}

  @Get()
  @Roles('ASESOR_BANCO', 'ADMIN')
  listar(@Query() filtro: ListarLotesDto) {
    return this.lotes.listar(filtro);
  }

  @Get(':id')
  @Roles('ASESOR_BANCO', 'ADMIN')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.lotes.detalle(id);
  }

  @Post(':id/ajuste')
  @Roles('ASESOR_BANCO')
  @HttpCode(200)
  ajustar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AjusteLoteDto,
  ) {
    return this.lotes.ajustar(id, dto, usuario.id);
  }
}

@ApiTags('inventario')
@ApiBearerAuth()
@Controller('distribuciones')
export class DistribucionesController {
  constructor(private readonly distribuciones: DistribucionesService) {}

  @Post()
  @Roles('ASESOR_BANCO')
  crear(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Body() dto: CrearDistribucionDto,
  ) {
    return this.distribuciones.crear(usuario.id, dto);
  }

  @Get()
  @Roles('ASESOR_BANCO', 'ADMIN')
  listar(@Query() filtro: ListarDistribucionesDto) {
    return this.distribuciones.listar(filtro);
  }

  @Get(':id')
  @Roles('ASESOR_BANCO', 'ADMIN')
  detalle(@Param('id', ParseUUIDPipe) id: string) {
    return this.distribuciones.detalle(id);
  }

  @Post(':id/confirmar')
  @Roles('ASESOR_BANCO')
  @HttpCode(200)
  confirmar(@Param('id', ParseUUIDPipe) id: string) {
    return this.distribuciones.confirmar(id);
  }

  @Post(':id/anular')
  @Roles('ASESOR_BANCO')
  @HttpCode(200)
  anular(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.distribuciones.anular(id, usuario.id);
  }
}

class FiltroAlertasDto {
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Transform(
    ({ value }: { value: unknown }) => value !== 'false' && value !== false,
  )
  @IsBoolean()
  solo_abiertas = true;
}

@ApiTags('inventario')
@ApiBearerAuth()
@Controller('alertas')
@Roles('ASESOR_BANCO', 'ADMIN')
export class AlertasController {
  constructor(private readonly lotes: LotesService) {}

  @Get()
  listar(@Query() filtro: FiltroAlertasDto) {
    return this.lotes.listarAlertas(filtro.solo_abiertas);
  }

  @Post(':id/atender')
  @Roles('ASESOR_BANCO')
  @HttpCode(200)
  atender(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AtenderAlertaDto,
  ) {
    return this.lotes.atenderAlerta(id, dto.accion_tomada, usuario.id);
  }
}

@ApiTags('indicadores')
@ApiBearerAuth()
@Controller('kpis')
@Roles('ASESOR_BANCO', 'ADMIN')
export class KpisController {
  constructor(private readonly kpis: KpisService) {}

  @Get('resumen')
  resumen(@Query() rango: RangoFechasDto) {
    return this.kpis.resumen(rango);
  }
}
