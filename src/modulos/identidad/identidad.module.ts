import { Module } from '@nestjs/common';
import { EvidenciasModule } from '../evidencias/evidencias.module';
import { MeController, VoluntarioController } from './identidad.controller';
import { IdentidadService } from './identidad.service';
import { PanelController } from './panel.controller';
import { PanelService } from './panel.service';
import { VoluntarioService } from './voluntario.service';

@Module({
  imports: [EvidenciasModule],
  controllers: [MeController, VoluntarioController, PanelController],
  providers: [IdentidadService, VoluntarioService, PanelService],
  exports: [VoluntarioService],
})
export class IdentidadModule {}
