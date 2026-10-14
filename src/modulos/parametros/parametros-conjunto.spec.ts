import { ParametrosService, CLAVES_EDITABLES } from './parametros.service';
import type { PrismaService } from '../../comun/prisma/prisma.service';
import type { TrazabilidadService } from '../../comun/trazabilidad/trazabilidad.service';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ActualizarParametrosDto } from '../admin/admin.dto';
const values = ['0.35', '0.25', '0.25', '0.15', '4'];
const changes = () =>
  CLAVES_EDITABLES.map((clave, index) => ({ clave, valor: values[index] }));
function fixture() {
  const rows = CLAVES_EDITABLES.map((clave, index) => ({
    id: String(index),
    clave,
    valor: ['0.30', '0.30', '0.25', '0.15', '5'][index],
    tipo_dato: index === 4 ? 'INT' : 'DECIMAL',
  }));
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    parametro_sistema: {
      findMany: jest.fn().mockResolvedValue(rows),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { valor: string };
        }) => ({ ...rows.find((row) => row.id === where.id), ...data }),
      ),
    },
  };
  const audit = jest.fn().mockResolvedValue(undefined);
  const service = new ParametrosService(
    {
      transaccion: async (fn: (tx: unknown) => unknown) => fn(tx),
    } as unknown as PrismaService,
    { auditar: audit } as unknown as TrazabilidadService,
  );
  return { service, tx, audit };
}
describe('configuración de asignación atómica', () => {
  it('valida el conjunto antes de escribir y audita en la misma transacción', async () => {
    const { service, tx, audit } = fixture();
    const result = await service.actualizarConjunto(changes(), 'admin');
    expect(result).toHaveLength(5);
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.parametro_sistema.update).toHaveBeenCalledTimes(5);
    expect(audit).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        nuevos: Object.fromEntries(
          changes().map((row) => [row.clave, row.valor]),
        ),
      }),
    );
  });
  it('no realiza ninguna escritura con una suma inválida', async () => {
    const { service, tx } = fixture();
    const bad = changes();
    bad[0].valor = '0.50';
    await expect(
      service.actualizarConjunto(bad, 'admin'),
    ).rejects.toMatchObject({ tipo: 'pesos-no-suman-uno' });
    expect(tx.parametro_sistema.update).not.toHaveBeenCalled();
  });
  it.each(['0', '6', '2.5'])(
    'rechaza un máximo de paradas %s',
    async (valor) => {
      const { service, tx } = fixture();
      const bad = changes();
      bad[4].valor = valor;
      await expect(
        service.actualizarConjunto(bad, 'admin'),
      ).rejects.toBeDefined();
      expect(tx.parametro_sistema.update).not.toHaveBeenCalled();
    },
  );
  it('rechaza duplicados y claves ajenas', async () => {
    const { service, tx } = fixture();
    const bad = changes();
    bad[1] = bad[0];
    await expect(
      service.actualizarConjunto(bad, 'admin'),
    ).rejects.toMatchObject({ tipo: 'parametros-incompletos' });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
  it('no escribe si falta un parámetro en la base', async () => {
    const { service, tx } = fixture();
    tx.parametro_sistema.findMany.mockResolvedValue([]);
    await expect(
      service.actualizarConjunto(changes(), 'admin'),
    ).rejects.toMatchObject({ tipo: 'no-encontrado' });
    expect(tx.parametro_sistema.update).not.toHaveBeenCalled();
  });
  it('valida tamaño, claves y valores anidados del DTO', async () => {
    expect(
      await validate(
        plainToInstance(ActualizarParametrosDto, { valores: changes() }),
        { whitelist: true, forbidNonWhitelisted: true },
      ),
    ).toHaveLength(0);
    expect(
      await validate(
        plainToInstance(ActualizarParametrosDto, {
          valores: changes().slice(1),
        }),
      ),
    ).not.toHaveLength(0);
    const bad = changes();
    bad[0].valor = 123 as unknown as string;
    expect(
      await validate(
        plainToInstance(ActualizarParametrosDto, { valores: bad }),
      ),
    ).not.toHaveLength(0);
  });
});
