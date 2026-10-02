import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ConfigApp, validarConfiguracion } from './configuracion';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // ENV_FILE permite arrancar contra otra base sin tocar .env (npm run start:local).
      envFilePath: process.env.ENV_FILE ?? '.env',
      validate: validarConfiguracion,
    }),
  ],
  providers: [ConfigApp],
  exports: [ConfigApp],
})
export class ConfigAppModule {}
