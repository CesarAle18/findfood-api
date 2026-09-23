import { Module } from '@nestjs/common';
import { EvidenciasModule } from '../evidencias/evidencias.module';
import { NotificacionesModule } from '../notificaciones/notificaciones.module';
import { AdminController, CatalogosController } from './admin.controller';
import { CatalogosService } from './catalogos.service';
import { UsuariosAdminService } from './usuarios-admin.service';
import { VerificacionesService } from './verificaciones.service';

@Module({
  imports: [EvidenciasModule, NotificacionesModule],
  controllers: [AdminController, CatalogosController],
  providers: [UsuariosAdminService, VerificacionesService, CatalogosService],
  exports: [UsuariosAdminService],
})
export class AdminModule {}
