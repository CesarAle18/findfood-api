import { Module } from '@nestjs/common';
import { DonacionesModule } from '../donaciones/donaciones.module';
import { NotificacionesModule } from '../notificaciones/notificaciones.module';
import { AlmacenesService } from './almacenes.service';
import { DistribucionesService } from './distribuciones.service';
import {
  AlertasController,
  AlmacenesController,
  DistribucionesController,
  KpisController,
  LotesController,
  RecepcionesController,
} from './inventario.controller';
import { KpisService } from './kpis.service';
import { LotesService } from './lotes.service';
import { RecepcionesService } from './recepciones.service';

@Module({
  imports: [DonacionesModule, NotificacionesModule],
  controllers: [
    AlmacenesController,
    RecepcionesController,
    LotesController,
    DistribucionesController,
    AlertasController,
    KpisController,
  ],
  providers: [
    AlmacenesService,
    RecepcionesService,
    LotesService,
    DistribucionesService,
    KpisService,
  ],
  exports: [LotesService, AlmacenesService],
})
export class InventarioModule {}
