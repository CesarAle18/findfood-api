import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { RolesGuard } from './roles.guard';
import { VerificadorJwt } from './verificador-jwt.service';

/** Guards globales en orden: AuthGuard y luego RolesGuard. Toda ruta nace protegida. */
@Global()
@Module({
  providers: [
    VerificadorJwt,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [VerificadorJwt],
})
export class AuthModule {}
