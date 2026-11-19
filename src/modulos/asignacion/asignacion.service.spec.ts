import { Logger } from '@nestjs/common';
import type { UsuarioAutenticado } from '../../comun/auth/tipos';
import type { PrismaService } from '../../comun/prisma/prisma.service';
import type { TrazabilidadService } from '../../comun/trazabilidad/trazabilidad.service';
import type { DonacionesService } from '../donaciones/donaciones.service';
import type { VoluntarioService } from '../identidad/voluntario.service';
import type { IncidenciasService } from '../incidencias/incidencias.service';
import type { NotificacionesService } from '../notificaciones/notificaciones.service';
import { AsignacionService } from './asignacion.service';
import type { MotorAsignacionService } from './motor.service';
import type { RutasDinamicasService } from './rutas-dinamicas.service';

const texto = (partes: TemplateStringsArray) => partes.join('?');
const voluntario = {
  id: 'vol-usuario',
  roles: ['VOLUNTARIO'],
} as unknown as UsuarioAutenticado;
const parada = { lat: 4.65, lng: -74.08 };
/** Deja correr las promesas en segundo plano (fire-and-forget). */
const enSegundoPlano = () => new Promise((r) => setImmediate(r));

function setup() {
  const tx = {
    $queryRaw: jest.fn((partes: TemplateStringsArray): Promise<unknown[]> => {
      const sql = texto(partes);
      if (sql.includes('FROM asignacion WHERE id'))
        return Promise.resolve([
          {
            donacion_id: 'd1',
            estado: 'ACEPTADA',
            voluntario_id: 'v1',
            ruta_id: 'r1',
          },
        ]);
      if (sql.includes("UPDATE parada_ruta p SET estado = 'OMITIDA'"))
        return Promise.resolve([
          { id: 'p1', anterior: 'PENDIENTE', ...parada },
        ]);
      // cancelarRutaVacia: la ruta conserva otras recogidas.
      return Promise.resolve([]);
    }),
    motivo: {
      findFirst: jest.fn().mockResolvedValue({
        id: 1,
        nombre: 'Imprevisto',
        codigo: 'IMPREVISTO',
        requiere_comentario: false,
      }),
    },
    parada_ruta: { count: jest.fn().mockResolvedValue(0) },
    asignacion: { update: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    transaccion: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const rutasDinamicas = { trazar: jest.fn().mockResolvedValue(undefined) };
  const servicio = new AsignacionService(
    prisma as unknown as PrismaService,
    { ofrecer: jest.fn() } as unknown as MotorAsignacionService,
    rutasDinamicas as unknown as RutasDinamicasService,
    { registrar: jest.fn() } as unknown as TrazabilidadService,
    { encolar: jest.fn() } as unknown as NotificacionesService,
    {
      propio: jest.fn().mockResolvedValue({ id: 'v1' }),
    } as unknown as VoluntarioService,
    { registrar: jest.fn() } as unknown as IncidenciasService,
    {
      reabrirPublicacion: jest.fn().mockResolvedValue(false),
      expirar: jest.fn().mockResolvedValue(true),
    } as unknown as DonacionesService,
  );
  return { servicio, rutasDinamicas, tx };
}

describe('AsignacionService: retrazar el tramo pendiente', () => {
  let advertencia: jest.SpyInstance;
  beforeEach(() => {
    advertencia = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('retrazarPendiente no espera a Google ni deja escapar su error', async () => {
    const { servicio, rutasDinamicas } = setup();
    rutasDinamicas.trazar.mockRejectedValue(new Error('Google caído'));
    expect(servicio.retrazarPendiente('r1', parada)).toBeUndefined();
    expect(rutasDinamicas.trazar).toHaveBeenCalledWith('r1', parada, {
      conservarDistancia: true,
    });
    await enSegundoPlano();
    expect(advertencia).toHaveBeenCalledWith(
      expect.objectContaining({ rutaId: 'r1' }),
      'No se pudo retrazar la ruta',
    );
  });

  it('trazarPendiente espera el trazado y deja que quien llama maneje el error', async () => {
    const { servicio, rutasDinamicas } = setup();
    await servicio.trazarPendiente('r1', parada, { conservarDistancia: false });
    expect(rutasDinamicas.trazar).toHaveBeenCalledWith('r1', parada, {
      conservarDistancia: false,
    });
    rutasDinamicas.trazar.mockRejectedValue(new Error('bd caída'));
    await expect(servicio.trazarPendiente('r1', parada)).rejects.toThrow(
      'bd caída',
    );
  });

  it('abandonar retraza la ruta desde la parada omitida, tras la transacción', async () => {
    const { servicio, rutasDinamicas } = setup();
    await servicio.abandonar(voluntario, 'as1', { motivo_id: 1 });
    expect(rutasDinamicas.trazar).toHaveBeenCalledTimes(1);
    expect(rutasDinamicas.trazar).toHaveBeenCalledWith('r1', parada, {
      conservarDistancia: true,
    });
  });

  it('abandonar responde aunque el retrazado falle', async () => {
    const { servicio, rutasDinamicas } = setup();
    rutasDinamicas.trazar.mockRejectedValue(new Error('Google caído'));
    await expect(
      servicio.abandonar(voluntario, 'as1', { motivo_id: 1 }),
    ).resolves.toMatchObject({ estado: 'ABANDONADA' });
    await enSegundoPlano();
  });

  it('abandonar sin parada abierta en la ruta no retraza', async () => {
    const { servicio, rutasDinamicas, tx } = setup();
    const original = tx.$queryRaw.getMockImplementation()!;
    tx.$queryRaw.mockImplementation((partes: TemplateStringsArray) =>
      texto(partes).includes("UPDATE parada_ruta p SET estado = 'OMITIDA'")
        ? Promise.resolve([])
        : original(partes),
    );
    await servicio.abandonar(voluntario, 'as1', { motivo_id: 1 });
    expect(rutasDinamicas.trazar).not.toHaveBeenCalled();
  });
});

describe('AsignacionService.cerrarVigentes: paradas omitidas para retrazar', () => {
  const cerrada = (ruta_id: string | null) => ({
    id: 'as1',
    anterior: 'ACEPTADA',
    voluntario_id: null,
    ruta_id,
  });

  it('devuelve la ruta y la ubicación de la parada que quedó OMITIDA', async () => {
    const { servicio, tx } = setup();
    const original = tx.$queryRaw.getMockImplementation()!;
    tx.$queryRaw.mockImplementation((partes: TemplateStringsArray) =>
      texto(partes).includes('UPDATE asignacion a')
        ? Promise.resolve([cerrada('r1')])
        : original(partes),
    );
    await expect(
      servicio.cerrarVigentes(tx as never, 'd1', 'CANCELADA'),
    ).resolves.toEqual([{ rutaId: 'r1', desde: parada }]);
  });

  it('no devuelve nada si la asignación no estaba en una ruta o su parada ya estaba cerrada', async () => {
    const { servicio, tx } = setup();
    tx.$queryRaw.mockImplementation((partes: TemplateStringsArray) => {
      const sql = texto(partes);
      if (sql.includes('UPDATE asignacion a'))
        return Promise.resolve([cerrada(null), cerrada('r2')]);
      // La parada de r2 ya no estaba PENDIENTE ni EN_SITIO.
      return Promise.resolve([]);
    });
    await expect(
      servicio.cerrarVigentes(tx as never, 'd1', 'EXPIRADA'),
    ).resolves.toEqual([]);
  });
});
