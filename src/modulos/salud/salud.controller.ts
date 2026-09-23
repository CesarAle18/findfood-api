import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { Publica } from '../../comun/auth/decoradores';
import { PrismaService } from '../../comun/prisma/prisma.service';

/** Comprobación de vida para Railway: si falla, reinicia el servicio (§7). */
@ApiTags('operación')
@Controller('health')
export class SaludController {
  constructor(
    private readonly salud: HealthCheckService,
    private readonly indicadores: HealthIndicatorService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @Publica()
  @HealthCheck()
  comprobar() {
    return this.salud.check([() => this.baseDeDatos()]);
  }

  private async baseDeDatos() {
    const indicador = this.indicadores.check('base_datos');
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return indicador.up();
    } catch (err) {
      return indicador.down({
        mensaje: err instanceof Error ? err.message : 'sin conexión',
      });
    }
  }
}
