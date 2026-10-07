import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Roles, UsuarioActual } from '../../comun/auth/decoradores';
import type { UsuarioAutenticado } from '../../comun/auth/tipos';
import { ParametrosService } from '../parametros/parametros.service';
import {
  ActualizarParametroDto,
  ActualizarTipoAlimentoDto,
  BancoDto,
  CrearUsuarioInternoDto,
  CambiarEstadoUsuarioDto,
  FiltroCatalogosDto,
  ListarUsuariosDto,
  ListarVerificacionesDto,
  RechazarVerificacionDto,
  SuspenderDto,
  TipoAlimentoDto,
} from './admin.dto';
import { CatalogosService } from './catalogos.service';
import { UsuariosAdminService } from './usuarios-admin.service';
import { VerificacionesService } from './verificaciones.service';

@ApiTags('administración')
@ApiBearerAuth()
@Controller('admin')
@Roles('ADMIN')
export class AdminController {
  constructor(
    private readonly usuarios: UsuariosAdminService,
    private readonly verificaciones: VerificacionesService,
    private readonly parametros: ParametrosService,
    private readonly catalogos: CatalogosService,
  ) {}

  // --- Cuentas ---------------------------------------------------------------

  /** Alta de cuentas internas (ADMIN o ASESOR_BANCO) con contraseña temporal. */
  @Post('usuarios')
  crearUsuario(
    @UsuarioActual() admin: UsuarioAutenticado,
    @Body() dto: CrearUsuarioInternoDto,
    @Req() peticion: Request,
  ) {
    return this.usuarios.crearUsuarioInterno(admin, dto, peticion);
  }

  @Get('usuarios')
  listarUsuarios(@Query() filtro: ListarUsuariosDto) {
    return this.usuarios.listar(filtro);
  }

  @Patch('usuarios/:id/estado')
  cambiarEstado(
    @UsuarioActual() admin: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CambiarEstadoUsuarioDto,
    @Req() peticion: Request,
  ) {
    return this.usuarios.cambiarEstado(admin, id, dto, peticion);
  }

  @Post('usuarios/:id/suspender')
  @HttpCode(200)
  suspender(
    @UsuarioActual() admin: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuspenderDto,
    @Req() peticion: Request,
  ) {
    return this.usuarios.suspender(admin, id, dto, peticion);
  }

  @Post('usuarios/:id/reactivar')
  @HttpCode(200)
  reactivar(
    @UsuarioActual() admin: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() peticion: Request,
  ) {
    return this.usuarios.reactivar(admin, id, peticion);
  }

  // --- Verificación de voluntarios ------------------------------------------

  @Get('verificaciones')
  listarVerificaciones(@Query() filtro: ListarVerificacionesDto) {
    return this.verificaciones.listar(filtro);
  }

  @Get('verificaciones/:id')
  verificacion(@Param('id', ParseUUIDPipe) id: string) {
    return this.verificaciones.detalle(id);
  }

  @Post('verificaciones/:id/aprobar')
  @HttpCode(200)
  aprobar(
    @UsuarioActual() admin: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() peticion: Request,
  ) {
    return this.verificaciones.aprobar(admin, id, peticion);
  }

  @Post('verificaciones/:id/rechazar')
  @HttpCode(200)
  rechazar(
    @UsuarioActual() admin: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RechazarVerificacionDto,
    @Req() peticion: Request,
  ) {
    return this.verificaciones.rechazar(admin, id, dto, peticion);
  }

  // --- Parámetros -------------------------------------------------------------

  @Get('parametros')
  listarParametros() {
    return this.parametros.listar();
  }

  @Put('parametros/:clave')
  actualizarParametro(
    @UsuarioActual() admin: UsuarioAutenticado,
    @Param('clave') clave: string,
    @Body() dto: ActualizarParametroDto,
    @Req() peticion: Request,
  ) {
    return this.parametros.actualizar(clave, dto.valor, admin.id, peticion);
  }

  // --- Banco y catálogo de alimentos -----------------------------------------

  @Get('banco')
  banco() {
    return this.catalogos.banco();
  }

  @Put('banco')
  guardarBanco(
    @UsuarioActual() admin: UsuarioAutenticado,
    @Body() dto: BancoDto,
    @Req() peticion: Request,
  ) {
    return this.catalogos.guardarBanco(dto, admin.id, peticion);
  }

  @Post('tipos-alimento')
  crearTipoAlimento(
    @UsuarioActual() admin: UsuarioAutenticado,
    @Body() dto: TipoAlimentoDto,
    @Req() peticion: Request,
  ) {
    return this.catalogos.crearTipoAlimento(dto, admin.id, peticion);
  }

  @Patch('tipos-alimento/:id')
  actualizarTipoAlimento(
    @UsuarioActual() admin: UsuarioAutenticado,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ActualizarTipoAlimentoDto,
    @Req() peticion: Request,
  ) {
    return this.catalogos.actualizarTipoAlimento(id, dto, admin.id, peticion);
  }
}

@ApiTags('catálogos')
@ApiBearerAuth()
@Controller('catalogos')
export class CatalogosController {
  constructor(private readonly catalogos: CatalogosService) {}

  /** ?incluir=unidades_medida,tipos_alimento · ?ambito=RECHAZO_ASIGNACION (motivos) */
  @Get()
  consultar(@Query() filtro: FiltroCatalogosDto) {
    return this.catalogos.consultar(filtro);
  }
}
