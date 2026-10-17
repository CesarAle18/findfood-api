import { validarAspectos } from './aspectos';
import type { Problema } from './http/problema';
import type { Tx } from './prisma/prisma.service';

const PUNTUALIDAD = { id: 1, codigo: 'PUNTUALIDAD', nombre: 'Puntualidad' };
const CUIDADO = {
  id: 3,
  codigo: 'CUIDADO',
  nombre: 'Cuidado de los alimentos',
};

function db(filas: { id: number; codigo: string; nombre: string }[]) {
  const findMany = jest.fn().mockResolvedValue(filas);
  return {
    findMany,
    db: { aspecto_calificacion: { findMany } } as unknown as Pick<
      Tx,
      'aspecto_calificacion'
    >,
  };
}

describe('aspectos de calificación (F-12)', () => {
  it('sin aspectos no consulta el catálogo', async () => {
    const { db: base, findMany } = db([]);
    await expect(
      validarAspectos(base, undefined, 'VOLUNTARIO'),
    ).resolves.toEqual([]);
    await expect(validarAspectos(base, [], 'VOLUNTARIO')).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('resuelve los códigos activos del rol calificado', async () => {
    const { db: base, findMany } = db([PUNTUALIDAD, CUIDADO]);
    const r = await validarAspectos(
      base,
      ['CUIDADO', 'PUNTUALIDAD'],
      'VOLUNTARIO',
    );
    expect(r).toEqual([PUNTUALIDAD, CUIDADO]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          rol_calificado: 'VOLUNTARIO',
          activo: true,
          codigo: { in: ['CUIDADO', 'PUNTUALIDAD'] },
        },
      }),
    );
  });

  it('un código ajeno al catálogo del rol responde 422 aspecto-invalido', async () => {
    const { db: base } = db([PUNTUALIDAD]);
    const error = await validarAspectos(
      base,
      ['PUNTUALIDAD', 'INVENTADO'],
      'VOLUNTARIO',
    ).catch((e: Problema) => e);
    expect(error).toMatchObject({
      tipo: 'aspecto-invalido',
      extensiones: { codigos_invalidos: ['INVENTADO'] },
    });
    expect((error as Problema).getStatus()).toBe(422);
  });

  it('ignora códigos repetidos al consultar', async () => {
    const { db: base, findMany } = db([PUNTUALIDAD]);
    await validarAspectos(base, ['PUNTUALIDAD', 'PUNTUALIDAD'], 'DONANTE');
    expect(findMany.mock.calls[0][0].where.codigo).toEqual({
      in: ['PUNTUALIDAD'],
    });
  });
});
