import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { UsuarioActual } from '../../comun/auth/decoradores';
import type { UsuarioAutenticado } from '../../comun/auth/tipos';
import { PaginacionDto } from '../../comun/validacion';
import { NotificacionesService } from './notificaciones.service';

class BandejaDto extends PaginacionDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(
    ({ value }: { value: unknown }) => value === 'true' || value === true,
  )
  @IsBoolean()
  solo_no_leidas = false;
}

@ApiTags('notificaciones')
@ApiBearerAuth()
@Controller('me/notificaciones')
export class NotificacionesController {
  constructor(private readonly notificaciones: NotificacionesService) {}

  @Get()
  bandeja(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Query() q: BandejaDto,
  ) {
    return this.notificaciones.bandeja(
      usuario.id,
      q.solo_no_leidas,
      q.limite,
      q.desplazamiento,
    );
  }

  @Post('leer-todas')
  @HttpCode(200)
  leerTodas(@UsuarioActual() usuario: UsuarioAutenticado) {
    return this.notificaciones.marcarTodasLeidas(usuario.id);
  }

  @Post(':id/leer')
  @HttpCode(204)
  async leer(
    @UsuarioActual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.notificaciones.marcarLeida(usuario.id, id);
  }
}
