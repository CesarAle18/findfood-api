import { forwardRef, Module } from '@nestjs/common';
import { DonacionesModule } from '../donaciones/donaciones.module';
import { IdentidadModule } from '../identidad/identidad.module';
import { IncidenciasModule } from '../incidencias/incidencias.module';
import { NotificacionesModule } from '../notificaciones/notificaciones.module';
import { AsignacionController } from './asignacion.controller';
import { AsignacionService } from './asignacion.service';
import { MotorAsignacionService } from './motor.service';

/**
 * Donaciones y asignación dependen una de la otra: publicar dispara la cascada
 * y aceptar cambia el estado de la donación, ambos en su transacción (forwardRef).
 */
@Module({
  imports: [
    forwardRef(() => DonacionesModule),
    IdentidadModule,
    IncidenciasModule,
    NotificacionesModule,
  ],
  controllers: [AsignacionController],
  providers: [AsignacionService, MotorAsignacionService],
  exports: [AsignacionService, MotorAsignacionService],
})
export class AsignacionModule {}
