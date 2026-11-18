import type { UsuarioAutenticado } from '../../comun/auth/tipos';
import type { GoogleRoutesService } from '../../comun/google/google-routes.service';
import type { PrismaService } from '../../comun/prisma/prisma.service';
import type { TrazabilidadService } from '../../comun/trazabilidad/trazabilidad.service';
import type { Prisma } from '../../generated/prisma/client';
import type { AsignacionService } from '../asignacion/asignacion.service';
import type { DonacionesService } from '../donaciones/donaciones.service';
import type { EvidenciasService } from '../evidencias/evidencias.service';
import type { VoluntarioService } from '../identidad/voluntario.service';
import type { IncidenciasService } from '../incidencias/incidencias.service';
import type { NotificacionesService } from '../notificaciones/notificaciones.service';
import type { ParametrosService } from '../parametros/parametros.service';
import { RuteoService } from './ruteo.service';

type Consulta = jest.Mock<
  Promise<unknown>,
  [TemplateStringsArray, ...unknown[]]
>;

/** Texto de una consulta etiquetada ($queryRaw`...`) para despachar el mock. */
const texto = (partes: TemplateStringsArray) => partes.join('?');

const origen = { lat: 4.6, lng: -74.1 };
const almacen = { id: 'a1', direccion: 'Sede', lat: 4.7, lng: -74.05 };
const donacion = {
  id: 'd1',
  codigo: 'DON-1',
  estado: 'PUBLICADA',
  peso_estimado_kg: 10,
  almacen_destino_id: almacen.id,
  ventana_recogida_inicio: new Date(Date.now() - 10 * 60_000),
  ventana_recogida_fin: new Date(Date.now() + 3 * 3_600_000),
  direccion_recogida: 'Calle 1',
  donante_usuario_id: 'donante',
  lat: 4.65,
  lng: -74.08,
};
const tramo = { duracionMin: 10, distanciaKm: 4 };
const matriz = [0, 1, 2].map(() => [0, 1, 2].map(() => tramo));

const asesor = {
  id: 'asesor',
  roles: ['ASESOR_BANCO'],
} as unknown as UsuarioAutenticado;
const voluntario = {
  id: 'vol-usuario',
  roles: ['VOLUNTARIO'],
} as unknown as UsuarioAutenticado;

function setup() {
  const insertRuta: unknown[][] = [];
  const parada = {
    parada_id: 'p1',
    ruta_id: 'r1',
    tipo: 'RECOGIDA',
    parada_estado: 'EN_SITIO',
    donacion_id: donacion.id,
    confirmada_por: null as string | null,
    lat: donacion.lat,
    lng: donacion.lng,
    id: 'r1',
    estado: 'EN_CURSO',
    voluntario_id: 'v1',
    voluntario_usuario_id: voluntario.id,
    banco_ejecutor_id: null,
    iniciada_at: new Date(),
  };
  const tx = {
    $queryRaw: jest.fn(
      (partes: TemplateStringsArray, ...valores: unknown[]) => {
        const sql = texto(partes);
        if (sql.includes('FROM donacion d JOIN donante'))
          return Promise.resolve([donacion]);
        if (sql.includes('INSERT INTO ruta')) {
          insertRuta.push(valores);
          return Promise.resolve([{ id: 'r1' }]);
        }
        if (sql.includes('FROM parada_ruta p'))
          return Promise.resolve([parada]);
        return Promise.resolve([]);
      },
    ) as Consulta,
    $executeRaw: jest.fn().mockResolvedValue(1),
    parada_ruta: {
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    ruta: { update: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    transaccion: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    $queryRaw: jest.fn((partes: TemplateStringsArray) => {
      const sql = texto(partes);
      if (sql.includes('FROM donacion d JOIN donante'))
        return Promise.resolve([donacion]);
      if (sql.includes('FROM banco_alimentos'))
        return Promise.resolve([
          { id: 'b1', tiene_flota_propia: true, ...origen },
        ]);
      if (sql.includes('FROM almacen')) return Promise.resolve([almacen]);
      return Promise.resolve([{ id: 'p1' }]);
    }) as Consulta,
  };
  const google = {
    matriz: jest.fn().mockResolvedValue(matriz),
    ruta: jest.fn().mockResolvedValue(null),
  };
  const parametros = {
    entero: jest.fn().mockResolvedValue(5),
    decimal: jest.fn().mockResolvedValue(50),
  };
  const asignacion = {
    asignarAFlota: jest.fn().mockResolvedValue('as1'),
    completar: jest.fn().mockResolvedValue(undefined),
    retrazarPendiente: jest.fn(),
  };
  const donaciones = {
    transicion: jest.fn().mockResolvedValue(true),
    bloquear: jest
      .fn()
      .mockResolvedValue({ donante_usuario_id: 'donante', codigo: 'DON-1' }),
  };
  const servicio = new RuteoService(
    prisma as unknown as PrismaService,
    parametros as unknown as ParametrosService,
    google as unknown as GoogleRoutesService,
    { registrar: jest.fn() } as unknown as TrazabilidadService,
    { encolar: jest.fn() } as unknown as NotificacionesService,
    {} as VoluntarioService,
    donaciones as unknown as DonacionesService,
    asignacion as unknown as AsignacionService,
    {
      contarDeParada: jest.fn().mockResolvedValue(1),
    } as unknown as EvidenciasService,
    { registrar: jest.fn() } as unknown as IncidenciasService,
  );
  jest.spyOn(servicio, 'detalle').mockResolvedValue({} as never);
  return { servicio, google, insertRuta, parada, tx, asignacion };
}

describe('RuteoService.crear: geometría planificada', () => {
  it('sin trazado de Google guarda geometria NULL y no marca el proveedor GOOGLE', async () => {
    const { servicio, insertRuta } = setup();
    await servicio.crear(asesor, { donacion_ids: [donacion.id] });
    // Los dos últimos valores del INSERT son geometria y proveedor_ruteo.
    const [geometria, proveedor] = insertRuta[0].slice(-2) as [
      Prisma.Sql,
      string | null,
    ];
    expect(geometria.sql).toBe('NULL');
    expect(proveedor).toBeNull();
  });

  it('con trazado de Google guarda la polilínea y marca el proveedor GOOGLE', async () => {
    const { servicio, google, insertRuta } = setup();
    google.ruta.mockResolvedValue({
      polilinea: 'abc',
      distanciaKm: 7,
      duracionMin: 20,
      tramosMin: [10, 10],
    });
    await servicio.crear(asesor, { donacion_ids: [donacion.id] });
    const [geometria, proveedor] = insertRuta[0].slice(-2) as [
      Prisma.Sql,
      string | null,
    ];
    expect(geometria.sql).toContain('ST_LineFromEncodedPolyline');
    expect(geometria.values).toEqual(['abc']);
    expect(proveedor).toBe('GOOGLE');
  });
});

describe('RuteoService: retrazar el tramo pendiente al cerrar una parada', () => {
  const confirmacion = {
    peso_confirmado_kg: 8,
    confirmacion_manual: true,
    confirmada_en_dispositivo: new Date().toISOString(),
  };
  const fallo = { tipo_incidencia_id: 1, descripcion: 'Donante ausente' };

  it('confirmar una recogida retraza desde la parada cerrada, después de la transacción', async () => {
    const { servicio, asignacion, parada, tx } = setup();
    asignacion.retrazarPendiente.mockImplementation(() => {
      // La transacción ya terminó: el UPDATE de la parada se ejecutó antes.
      expect(tx.$executeRaw).toHaveBeenCalled();
    });
    await servicio.confirmar(voluntario, parada.parada_id, confirmacion);
    expect(asignacion.retrazarPendiente).toHaveBeenCalledTimes(1);
    expect(asignacion.retrazarPendiente).toHaveBeenCalledWith('r1', {
      lat: donacion.lat,
      lng: donacion.lng,
    });
  });

  it('repetir la confirmación propia no retraza: nada cambió', async () => {
    const { servicio, asignacion, parada } = setup();
    parada.parada_estado = 'COMPLETADA';
    parada.confirmada_por = voluntario.id;
    await servicio.confirmar(voluntario, parada.parada_id, confirmacion);
    expect(asignacion.retrazarPendiente).not.toHaveBeenCalled();
  });

  it('confirmar la entrega no retraza: la ruta termina', async () => {
    const { servicio, asignacion, parada } = setup();
    parada.tipo = 'ENTREGA';
    await servicio.confirmar(voluntario, parada.parada_id, {
      ...confirmacion,
      peso_confirmado_kg: undefined,
    });
    expect(asignacion.retrazarPendiente).not.toHaveBeenCalled();
  });

  it('marcar una recogida fallida retraza desde la parada cerrada', async () => {
    const { servicio, asignacion, parada } = setup();
    await servicio.fallida(voluntario, parada.parada_id, fallo as never);
    expect(asignacion.retrazarPendiente).toHaveBeenCalledWith('r1', {
      lat: donacion.lat,
      lng: donacion.lng,
    });
  });

  it('una recogida fallida que cancela la ruta no retraza', async () => {
    const { servicio, asignacion, parada, tx } = setup();
    tx.parada_ruta.count.mockResolvedValue(0);
    await servicio.fallida(voluntario, parada.parada_id, fallo as never);
    expect(asignacion.retrazarPendiente).not.toHaveBeenCalled();
  });

  it('si la transacción falla no retraza', async () => {
    const { servicio, asignacion, parada, tx } = setup();
    tx.parada_ruta.update.mockRejectedValue(new Error('bd caída'));
    await expect(
      servicio.fallida(voluntario, parada.parada_id, fallo as never),
    ).rejects.toThrow('bd caída');
    expect(asignacion.retrazarPendiente).not.toHaveBeenCalled();
  });
});
