import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { NextFunction, Request, Response } from 'express';
import type { PeticionAutenticada } from '../../comun/auth/decoradores';
import type { UsuarioAutenticado } from '../../comun/auth/tipos';
import { noEncontrado } from '../../comun/http/problema';
import { NotificacionesController } from './notificaciones.controller';
import { NotificacionesService } from './notificaciones.service';

// Transporte real; identidad y persistencia simuladas, sin servicios externos.
describe('contratos HTTP de la bandeja de notificaciones', () => {
  let app: INestApplication;
  const usuarioId = 'usuario-de-prueba';
  const notificacionId = '12345678-1234-4234-8234-123456789abc';
  const eliminar = jest.fn().mockResolvedValue(undefined);
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [NotificacionesController],
      providers: [{ provide: NotificacionesService, useValue: { eliminar } }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('v1');
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as PeticionAutenticada).usuario = {
        id: usuarioId,
        roles: ['DONANTE'],
      } as UsuarioAutenticado;
      next();
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    eliminar.mockClear();
  });
  it('elimina con DELETE /v1/me/notificaciones/:id y responde 204', async () => {
    await request(app.getHttpServer())
      .delete(`/v1/me/notificaciones/${notificacionId}`)
      .expect(204);
    expect(eliminar).toHaveBeenCalledWith(usuarioId, notificacionId);
  });
  it('responde 404 si la notificación no existe o es de otro usuario', async () => {
    eliminar.mockRejectedValueOnce(noEncontrado('Notificación'));
    await request(app.getHttpServer())
      .delete(`/v1/me/notificaciones/${notificacionId}`)
      .expect(404);
    expect(eliminar).toHaveBeenCalledTimes(1);
  });
  it('rechaza un id que no es UUID sin llamar al servicio', async () => {
    await request(app.getHttpServer())
      .delete('/v1/me/notificaciones/no-uuid')
      .expect(400);
    expect(eliminar).not.toHaveBeenCalled();
  });
});
