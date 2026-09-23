import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../comun/auth/decoradores';
import { TareasService } from './tareas.service';

/** Salud del reloj (§16): última ejecución exitosa de cada tarea. */
@ApiTags('operación')
@ApiBearerAuth()
@Controller('admin/tareas')
@Roles('ADMIN')
export class TareasController {
  constructor(private readonly tareas: TareasService) {}

  @Get()
  estado() {
    return Object.fromEntries(this.tareas.estado);
  }
}
