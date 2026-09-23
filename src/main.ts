import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ConfigApp } from './config/configuracion';
import { configurarApp } from './configurar-app';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  const config = app.get(ConfigApp);
  configurarApp(app, config.get('CORS_ORIGENES'));

  const docsHabilitados =
    config.get('DOCS_HABILITADOS') ?? !config.esProduccion;
  if (docsHabilitados) {
    const documento = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('FindFood API')
        .setDescription(
          'Gestión y trazabilidad de donaciones de alimentos (docs/arquitectura.md §11). ' +
            'Errores en application/problem+json (RFC 9457).',
        )
        .setVersion('1.0')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('docs', app, documento);
  }

  await app.listen(config.get('PORT'), '0.0.0.0');
}
void bootstrap();
