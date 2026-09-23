import { Module } from '@nestjs/common';
import { AsignacionModule } from '../asignacion/asignacion.module';
import { DonacionesModule } from '../donaciones/donaciones.module';
import { EvidenciasModule } from '../evidencias/evidencias.module';
import { IdentidadModule } from '../identidad/identidad.module';
import { IncidenciasModule } from '../incidencias/incidencias.module';
import { NotificacionesModule } from '../notificaciones/notificaciones.module';
import { ParadasController, RutasController } from './ruteo.controller';
import { RuteoService } from './ruteo.service';

@Module({
  imports: [
    AsignacionModule,
    DonacionesModule,
    EvidenciasModule,
    IdentidadModule,
    IncidenciasModule,
    NotificacionesModule,
  ],
  controllers: [RutasController, ParadasController],
  providers: [RuteoService],
})
export class RuteoModule {}
