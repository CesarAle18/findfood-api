import { Module } from '@nestjs/common';
import { EnvioNotificacionesService } from './envio.service';
import { NotificacionesController } from './notificaciones.controller';
import { NotificacionesService } from './notificaciones.service';
import { ExpoPushService, ProveedorPush } from './proveedor-push';

@Module({
  controllers: [NotificacionesController],
  providers: [
    NotificacionesService,
    EnvioNotificacionesService,
    { provide: ProveedorPush, useClass: ExpoPushService },
  ],
  exports: [NotificacionesService, EnvioNotificacionesService],
})
export class NotificacionesModule {}
