import type { GoogleRoutesService } from '../../comun/google/google-routes.service';
import type { PrismaService } from '../../comun/prisma/prisma.service';
import type { TrazabilidadService } from '../../comun/trazabilidad/trazabilidad.service';
import type { ParametrosService } from '../parametros/parametros.service';
import { RutasDinamicasService } from './rutas-dinamicas.service';

const texto = (partes: TemplateStringsArray) => partes.join('?');
const desde = { lat: 4.6, lng: -74.1 };
const pendientes = [
  { id: 'p2', lat: 4.65, lng: -74.08 },
  { id: 'p3', lat: 4.7, lng: -74.05 },
];

function setup() {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue(pendientes),
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const google = {
    disponible: true,
    ruta: jest.fn().mockResolvedValue({
      polilinea: 'abc',
      distanciaKm: 3.456,
      duracionMin: 9,
    }),
  };
  const servicio = new RutasDinamicasService(
    prisma as unknown as PrismaService,
    google as unknown as GoogleRoutesService,
    {} as unknown as ParametrosService,
    {} as unknown as TrazabilidadService,
  );
  /** SQL y valores del UPDATE ruta que escribió trazar(). */
  const escritura = () => {
    const [partes, ...valores] = prisma.$executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    return { sql: texto(partes), valores };
  };
  return { servicio, prisma, google, escritura };
}

describe('RutasDinamicasService.trazar', () => {
  it('por defecto guarda la geometría y la distancia del tramo trazado', async () => {
    const { servicio, google, escritura } = setup();
    await servicio.trazar('r1', desde);
    expect(google.ruta).toHaveBeenCalledWith([desde, ...pendientes]);
    const { sql, valores } = escritura();
    expect(sql).toContain('geometria = ');
    expect(sql).toContain("proveedor_ruteo = 'GOOGLE'");
    expect(valores).toContain(3.46);
  });

  it('con conservarDistancia solo cambia la geometría: la distancia planificada se mantiene', async () => {
    const { servicio, escritura } = setup();
    await servicio.trazar('r1', desde, { conservarDistancia: true });
    const { sql, valores } = escritura();
    expect(sql).toContain('geometria = ');
    expect(sql).toContain("proveedor_ruteo = 'GOOGLE'");
    expect(valores).not.toContain(3.46);
    expect(valores).toContain(null);
    // La guarda contra escrituras viejas sigue en pie: la firma de paradas pendientes.
    expect(sql).toContain('string_agg(id::text');
    expect(valores).toContain('p2,p3');
  });

  it('sin paradas pendientes no llama a Google ni escribe', async () => {
    const { servicio, prisma, google } = setup();
    prisma.$queryRaw.mockResolvedValue([]);
    await servicio.trazar('r1', desde, { conservarDistancia: true });
    expect(google.ruta).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});
