import { forwardRef, Module } from '@nestjs/common';
import { AsignacionModule } from '../asignacion/asignacion.module';
import { EvidenciasModule } from '../evidencias/evidencias.module';
import { NotificacionesModule } from '../notificaciones/notificaciones.module';
import { DonacionesController } from './donaciones.controller';
import { DonacionesService } from './donaciones.service';

@Module({
  imports: [
    forwardRef(() => AsignacionModule),
    EvidenciasModule,
    NotificacionesModule,
  ],
  controllers: [DonacionesController],
  providers: [DonacionesService],
  exports: [DonacionesService],
})
export class DonacionesModule {}
