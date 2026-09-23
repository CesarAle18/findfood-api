import { RequestMethod, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { FiltroProblemas } from './comun/http/filtro-problemas';
import { SerializacionInterceptor } from './comun/http/serializacion.interceptor';

/** Configuración HTTP compartida por main.ts y las pruebas e2e. */
export function configurarApp(
  app: NestExpressApplication,
  origenesCors: string[] = [],
): void {
  app.setGlobalPrefix('v1', {
    exclude: [{ path: 'health', method: RequestMethod.GET }],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      stopAtFirstError: false,
    }),
  );
  app.useGlobalFilters(new FiltroProblemas());
  app.useGlobalInterceptors(new SerializacionInterceptor());
  // Railway termina TLS en su proxy: la IP real llega en X-Forwarded-For.
  app.set('trust proxy', 1);
  app.enableCors({
    origin: origenesCors.length ? origenesCors : false,
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
  });
  app.enableShutdownHooks();
}
