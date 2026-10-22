import { Global, Module } from '@nestjs/common';
import { GoogleLugaresService } from './google-lugares.service';
import { GoogleRoutesService } from './google-routes.service';

@Global()
@Module({
  providers: [GoogleRoutesService, GoogleLugaresService],
  exports: [GoogleRoutesService, GoogleLugaresService],
})
export class GoogleModule {}
