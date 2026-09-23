import { Global, Module } from '@nestjs/common';
import { TrazabilidadService } from './trazabilidad.service';

@Global()
@Module({
  providers: [TrazabilidadService],
  exports: [TrazabilidadService],
})
export class TrazabilidadModule {}
