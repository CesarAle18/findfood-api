import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { RolesGuard } from '../../comun/auth/roles.guard';
import type { PeticionAutenticada } from '../../comun/auth/decoradores';
import type { UsuarioAutenticado } from '../../comun/auth/tipos';
import { PrismaService } from '../../comun/prisma/prisma.service';
import { AuditoriaController } from './auditoria.controller';
import { ListarAuditoriaDto } from './auditoria.dto';
import { AuditoriaService } from './auditoria.service';

describe('consulta global de auditoría', () => {
  let app: INestApplication;
  let service: AuditoriaService;
  const findMany = jest.fn();
  const count = jest.fn();
  const transaction = jest.fn(async (queries: Promise<unknown>[]) =>
    Promise.all(queries),
  );
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AuditoriaController],
      providers: [
        AuditoriaService,
        {
          provide: PrismaService,
          useValue: {
            auditoria: { findMany, count },
            $transaction: transaction,
          },
        },
      ],
    }).compile();
    service = module.get(AuditoriaService);
    app = module.createNestApplication();
    app.setGlobalPrefix('v1');
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as PeticionAutenticada).usuario = {
        roles: [req.headers['x-test-role'] || 'ADMIN'],
      } as UsuarioAutenticado;
      next();
    });
    app.useGlobalGuards(new RolesGuard(new Reflector()));
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    findMany.mockResolvedValue([
      {
        id: 9007199254740993n,
        created_at: new Date('2026-11-03T12:00:00Z'),
        usuario_id: 'actor-id',
        accion: 'RECHAZAR',
        entidad: 'verificacion_identidad',
        entidad_id: 'verificacion-id',
        valores_anteriores: null,
        valores_nuevos: { estado: 'RECHAZADA' },
        usuario: {
          nombres: 'Ana',
          apellidos: 'Pérez',
          email: 'ana@example.test',
          usuario_rol_usuario_rol_usuario_idTousuario: [
            { rol: { codigo: 'ASESOR_BANCO' } },
          ],
        },
      },
    ]);
    count.mockResolvedValue(1);
  });

  it('entrega el formato que valida el frontend, incluidos actores asesores', async () => {
    const { body } = await request(app.getHttpServer())
      .get('/v1/admin/auditoria?limite=100&desplazamiento=0')
      .expect(200);
    expect(body).toMatchObject({
      total: 1,
      limite: 100,
      desplazamiento: 0,
      datos: [
        {
          id: '9007199254740993',
          fecha: '2026-11-03T12:00:00.000Z',
          actor: 'Ana Pérez',
          roles: ['ASESOR_BANCO'],
          modulo: 'Usuarios',
          accion: 'RECHAZAR',
          entidad: 'verificacion_identidad',
          metodo: '',
        },
      ],
    });
    expect(findMany.mock.calls[0][0].where.usuario).toBeUndefined();
  });
  it.each(['ASESOR_BANCO', 'DONANTE', 'VOLUNTARIO'])(
    'impide consultar como %s',
    async (role) => {
      await request(app.getHttpServer())
        .get('/v1/admin/auditoria')
        .set('x-test-role', role)
        .expect(403);
      expect(findMany).not.toHaveBeenCalled();
    },
  );
  it.each([
    'desde=2026-02-30',
    'hasta=no-fecha',
    'limite=101',
    'desplazamiento=-1',
    'usuario_id=invalido',
    'rol=OTRO',
  ])('valida %s', async (query) => {
    await request(app.getHttpServer())
      .get(`/v1/admin/auditoria?${query}`)
      .expect(400);
    expect(findMany).not.toHaveBeenCalled();
  });
  it('rechaza intervalos invertidos', async () => {
    await request(app.getHttpServer())
      .get(
        '/v1/admin/auditoria?desde=2026-11-04T00:00:00Z&hasta=2026-11-03T00:00:00Z',
      )
      .expect(400);
    expect(findMany).not.toHaveBeenCalled();
  });
  it('aplica fechas inclusiva/exclusiva, filtros y orden estable antes de paginar', async () => {
    const filtro = Object.assign(new ListarAuditoriaDto(), {
      desde: '2026-11-01T05:00:00Z',
      hasta: '2026-11-04T05:00:00Z',
      usuario_id: 'actor-id',
      rol: 'ASESOR_BANCO',
      entidad: 'usuario',
      accion: 'CREAR',
      desplazamiento: 100,
    });
    await service.listar(filtro);
    const query = findMany.mock.calls[0][0];
    expect(query).toMatchObject({
      skip: 100,
      take: 20,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      where: {
        usuario_id: 'actor-id',
        entidad: 'usuario',
        accion: 'CREAR',
        created_at: { gte: new Date(filtro.desde), lt: new Date(filtro.hasta) },
        usuario: {
          usuario_rol_usuario_rol_usuario_idTousuario: {
            some: { activo: true, rol: { codigo: 'ASESOR_BANCO' } },
          },
        },
      },
    });
    expect(count).toHaveBeenCalledWith({ where: query.where });
  });
  it('admite registros del sistema y páginas vacías', async () => {
    const row = (await findMany())[0];
    findMany.mockResolvedValueOnce([
      { ...row, usuario: null, usuario_id: null },
    ]);
    expect(
      (await service.listar(new ListarAuditoriaDto())).datos[0],
    ).toMatchObject({ actor: 'Sistema', roles: [] });
    findMany.mockResolvedValueOnce([]);
    count.mockResolvedValueOnce(0);
    expect(await service.listar(new ListarAuditoriaDto())).toMatchObject({
      datos: [],
      total: 0,
    });
  });
});
