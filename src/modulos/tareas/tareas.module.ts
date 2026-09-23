import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminModule } from '../admin/admin.module';
import { AsignacionModule } from '../asignacion/asignacion.module';
import { DonacionesModule } from '../donaciones/donaciones.module';
import { InventarioModule } from '../inventario/inventario.module';
import { NotificacionesModule } from '../notificaciones/notificaciones.module';
import { TareasController } from './tareas.controller';
import { TareasService } from './tareas.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    AdminModule,
    AsignacionModule,
    DonacionesModule,
    InventarioModule,
    NotificacionesModule,
  ],
  controllers: [TareasController],
  providers: [TareasService],
  exports: [TareasService],
})
export class TareasModule {}
