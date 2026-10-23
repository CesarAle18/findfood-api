import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UsuarioActual } from '../../comun/auth/decoradores';
import type { UsuarioAutenticado } from '../../comun/auth/tipos';
import {
  AutocompletarDto,
  GeocodificarDto,
  InversaDto,
  SesionGeoDto,
} from './geo.dto';
import { GeoService } from './geo.service';

/**
 * Búsqueda de direcciones para cualquier usuario autenticado. Si Google no
 * está disponible responde 503 geo-no-disponible y el cliente usa su respaldo
 * (geocoder del dispositivo o ubicar el pin a mano).
 */
@ApiTags('geo')
@ApiBearerAuth()
@Controller('geo')
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  @Get('autocompletar')
  autocompletar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Query() dto: AutocompletarDto,
  ) {
    return this.geo.autocompletar(usuario.id, dto);
  }

  @Get('lugares/:placeId')
  lugar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('placeId') placeId: string,
    @Query() dto: SesionGeoDto,
  ) {
    return this.geo.lugar(usuario.id, placeId, dto.sesion);
  }

  @Get('geocodificar')
  geocodificar(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Query() dto: GeocodificarDto,
  ) {
    return this.geo.geocodificar(usuario.id, dto);
  }

  @Get('inversa')
  inversa(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Query() dto: InversaDto,
  ) {
    return this.geo.inversa(usuario.id, dto);
  }
}
