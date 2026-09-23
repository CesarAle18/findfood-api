import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ConfigApp, validarConfiguracion } from './configuracion';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validarConfiguracion,
    }),
  ],
  providers: [ConfigApp],
  exports: [ConfigApp],
})
export class ConfigAppModule {}
