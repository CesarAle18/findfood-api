import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../comun/auth/decoradores';
import { ListarAuditoriaDto } from './auditoria.dto';
import { AuditoriaService } from './auditoria.service';

@ApiTags('administración')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/auditoria')
export class AuditoriaController {
  constructor(private readonly auditoria: AuditoriaService) {}

  @Get()
  @ApiOperation({
    summary: 'Consultar auditorías globales de todos los usuarios',
  })
  listar(@Query() filtro: ListarAuditoriaDto) {
    return this.auditoria.listar(filtro);
  }
}
