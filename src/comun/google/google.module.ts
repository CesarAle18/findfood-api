import { Global, Module } from '@nestjs/common';
import { GoogleRoutesService } from './google-routes.service';

@Global()
@Module({
  providers: [GoogleRoutesService],
  exports: [GoogleRoutesService],
})
export class GoogleModule {}
