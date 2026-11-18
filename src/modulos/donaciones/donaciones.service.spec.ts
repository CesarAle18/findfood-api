import type { UsuarioAutenticado } from '../../comun/auth/tipos';
import type { PrismaService } from '../../comun/prisma/prisma.service';
import type { TrazabilidadService } from '../../comun/trazabilidad/trazabilidad.service';
import type { AsignacionService } from '../asignacion/asignacion.service';
import type { ArchivosService } from '../evidencias/archivos.service';
import type { NotificacionesService } from '../notificaciones/notificaciones.service';
import type { ParametrosService } from '../parametros/parametros.service';
import {
  type DonacionBloqueada,
  DonacionesService,
} from './donaciones.service';

const parada = { lat: 4.65, lng: -74.08 };
const omitida = { rutaId: 'r1', desde: parada };
const donante = {
  id: 'donante-usuario',
  roles: ['DONANTE'],
} as unknown as UsuarioAutenticado;
const asesor = {
  id: 'asesor',
  roles: ['ASESOR_BANCO'],
} as unknown as UsuarioAutenticado;
const bloqueada: DonacionBloqueada = {
  id: 'd1',
  codigo: 'DON-1',
  estado: 'ASIGNADA',
  donante_id: 'dn1',
  donante_usuario_id: donante.id,
  ventana_recogida_inicio: new Date(),
  ventana_recogida_fin: new Date(Date.now() + 3_600_000),
  expira_publicacion_at: null,
};

function setup() {
  const asignacion = {
    cerrarVigentes: jest.fn().mockResolvedValue([omitida]),
    retrazarPendiente: jest.fn(),
    ofrecer: jest.fn().mockResolvedValue(1),
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'd1' }, { id: 'd2' }]),
    motivo: {
      findFirst: jest.fn().mockResolvedValue({
        id: 1,
        nombre: 'Ya no está disponible',
        codigo: 'NO_DISPONIBLE',
        requiere_comentario: false,
      }),
    },
    parada_ruta: { count: jest.fn().mockResolvedValue(0) },
    donacion: { update: jest.fn().mockResolvedValue({}) },
  };
  /** El retrazado espera a que la transacción confirme. */
  const confirmar = async (fn: (t: typeof tx) => Promise<unknown>) => {
    const r = await fn(tx);
    expect(asignacion.retrazarPendiente).not.toHaveBeenCalled();
    return r;
  };
  const prisma = {
    transaccion: jest.fn(confirmar),
    $transaction: jest.fn(confirmar),
  };
  const servicio = new DonacionesService(
    prisma as unknown as PrismaService,
    { registrar: jest.fn() } as unknown as TrazabilidadService,
    { encolar: jest.fn() } as unknown as NotificacionesService,
    {} as unknown as ParametrosService,
    {} as unknown as ArchivosService,
    asignacion as unknown as AsignacionService,
  );
  jest.spyOn(servicio, 'bloquear').mockResolvedValue(bloqueada);
  jest.spyOn(servicio, 'transicion').mockResolvedValue(true);
  jest.spyOn(servicio, 'expirar').mockResolvedValue(true);
  jest.spyOn(servicio, 'reabrirPublicacion').mockResolvedValue(true);
  jest
    .spyOn(servicio, 'detalle')
    .mockResolvedValue({ id: 'd1' } as Awaited<
      ReturnType<DonacionesService['detalle']>
    >);
  return { servicio, asignacion };
}

describe('DonacionesService: retrazar la ruta cuyas paradas se cierran', () => {
  afterEach(() => jest.restoreAllMocks());

  it('cancelar retraza la ruta desde la parada omitida, tras la transacción', async () => {
    const { servicio, asignacion } = setup();
    await expect(
      servicio.cancelar(donante, 'd1', { motivo_id: 1 }),
    ).resolves.toEqual({ id: 'd1' });
    expect(asignacion.retrazarPendiente).toHaveBeenCalledTimes(1);
    expect(asignacion.retrazarPendiente).toHaveBeenCalledWith('r1', parada);
  });

  it('cancelar sin parada omitida no retraza', async () => {
    const { servicio, asignacion } = setup();
    asignacion.cerrarVigentes.mockResolvedValue([]);
    await servicio.cancelar(donante, 'd1', { motivo_id: 1 });
    expect(asignacion.retrazarPendiente).not.toHaveBeenCalled();
  });

  it('cancelar no retraza si la transacción falla', async () => {
    const { servicio, asignacion } = setup();
    jest.spyOn(servicio, 'bloquear').mockResolvedValue(undefined);
    await expect(
      servicio.cancelar(donante, 'd1', { motivo_id: 1 }),
    ).rejects.toThrow();
    expect(asignacion.retrazarPendiente).not.toHaveBeenCalled();
  });

  it('reasignar retraza la ruta que pierde la parada y conserva su respuesta', async () => {
    const { servicio, asignacion } = setup();
    await expect(servicio.reasignar(asesor, 'd1')).resolves.toEqual({
      id: 'd1',
      oferta_en_curso: true,
    });
    expect(asignacion.retrazarPendiente).toHaveBeenCalledTimes(1);
    expect(asignacion.retrazarPendiente).toHaveBeenCalledWith('r1', parada);
  });

  it('expirar publicaciones vencidas retraza cada ruta afectada y devuelve cuántas expiraron', async () => {
    const { servicio, asignacion } = setup();
    asignacion.cerrarVigentes
      .mockResolvedValueOnce([omitida])
      .mockResolvedValueOnce([]);
    await expect(servicio.expirarPublicacionesVencidas()).resolves.toBe(2);
    expect(asignacion.retrazarPendiente).toHaveBeenCalledTimes(1);
    expect(asignacion.retrazarPendiente).toHaveBeenCalledWith('r1', parada);
  });
});
