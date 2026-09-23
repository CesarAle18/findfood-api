import { Module } from '@nestjs/common';
import { ArchivosService } from './archivos.service';
import { EvidenciasController } from './evidencias.controller';
import { EvidenciasService } from './evidencias.service';

@Module({
  controllers: [EvidenciasController],
  providers: [ArchivosService, EvidenciasService],
  exports: [ArchivosService, EvidenciasService],
})
export class EvidenciasModule {}
