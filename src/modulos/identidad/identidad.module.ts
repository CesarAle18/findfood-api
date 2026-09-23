import { Module } from '@nestjs/common';
import { EvidenciasModule } from '../evidencias/evidencias.module';
import { MeController, VoluntarioController } from './identidad.controller';
import { IdentidadService } from './identidad.service';
import { VoluntarioService } from './voluntario.service';

@Module({
  imports: [EvidenciasModule],
  controllers: [MeController, VoluntarioController],
  providers: [IdentidadService, VoluntarioService],
  exports: [VoluntarioService],
})
export class IdentidadModule {}
