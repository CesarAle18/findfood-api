import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { NextFunction, Request, Response } from 'express';
import { RolesGuard } from '../../comun/auth/roles.guard';
import type { PeticionAutenticada } from '../../comun/auth/decoradores';
import type { UsuarioAutenticado } from '../../comun/auth/tipos';
import { ParametrosService } from '../parametros/parametros.service';
import { AdminController } from './admin.controller';
import { CatalogosService } from './catalogos.service';
import { UsuariosAdminService } from './usuarios-admin.service';
import { VerificacionesService } from './verificaciones.service';

// Transporte y RolesGuard reales; identidad y persistencia simuladas, sin servicios externos.
describe('contratos HTTP de administración de usuarios', () => {
  let app: INestApplication;
  const userId = '12345678-1234-4234-8234-123456789abc';
  const change = jest
    .fn()
    .mockResolvedValue({ id: userId, estado: 'INACTIVO' });
  const create = jest
    .fn()
    .mockResolvedValue({ id: userId, correo_enviado: true });
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        {
          provide: UsuariosAdminService,
          useValue: { cambiarEstado: change, crearUsuarioInterno: create },
        },
        { provide: VerificacionesService, useValue: {} },
        { provide: ParametrosService, useValue: {} },
        { provide: CatalogosService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('v1');
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as PeticionAutenticada).usuario = {
        id: 'test-admin',
        roles: [req.headers['x-test-role'] || 'ADMIN'],
      } as UsuarioAutenticado;
      next();
    });
    app.useGlobalGuards(new RolesGuard(new Reflector()));
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
    change.mockClear();
    create.mockClear();
  });
  it('crea usando POST /v1/admin/usuarios y entrega rol validado', async () => {
    await request(app.getHttpServer())
      .post('/v1/admin/usuarios')
      .send({
        rol: 'ASESOR_BANCO',
        email: 'nora@example.test',
        nombres: 'Nora',
        apellidos: 'Pérez',
        telefono: '3104445566',
      })
      .expect(201);
    expect(create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rol: 'ASESOR_BANCO',
        telefono: '+573104445566',
      }),
      expect.anything(),
    );
  });
  it('acepta ADMIN y rechaza un rol no interno en el alta', async () => {
    const body = {
      email: 'admin@example.test',
      nombres: 'Ana',
      telefono: '3104445566',
    };
    await request(app.getHttpServer())
      .post('/v1/admin/usuarios')
      .send({ ...body, rol: 'ADMIN' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/v1/admin/usuarios')
      .send({ ...body, rol: 'DONANTE' })
      .expect(400);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('cambia el estado con PATCH /v1/admin/usuarios/:id/estado', async () => {
    await request(app.getHttpServer())
      .patch(`/v1/admin/usuarios/${userId}/estado`)
      .send({ estado: 'INACTIVO' })
      .expect(200);
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({ roles: ['ADMIN'] }),
      userId,
      expect.objectContaining({ estado: 'INACTIVO' }),
      expect.anything(),
    );
  });
  it('impide el cambio con rol asesor', async () => {
    await request(app.getHttpServer())
      .patch(`/v1/admin/usuarios/${userId}/estado`)
      .set('x-test-role', 'ASESOR_BANCO')
      .send({ estado: 'INACTIVO' })
      .expect(403);
    expect(change).not.toHaveBeenCalled();
  });
  it('rechaza UUID o estado inválido y campos adicionales', async () => {
    await request(app.getHttpServer())
      .patch('/v1/admin/usuarios/no-uuid/estado')
      .send({ estado: 'INACTIVO' })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/v1/admin/usuarios/${userId}/estado`)
      .send({ estado: 'SUSPENDIDO' })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/v1/admin/usuarios/${userId}/estado`)
      .send({ estado: 'ACTIVO', rol: 'ADMIN' })
      .expect(400);
    expect(change).not.toHaveBeenCalled();
  });
});
