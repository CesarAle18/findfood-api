import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ConfirmarParadaDto } from './ruteo.dto';

const base = { confirmada_en_dispositivo: '2026-10-17T10:00:00.000Z' };

async function errores(cuerpo: Record<string, unknown>) {
  const dto = plainToInstance(ConfirmarParadaDto, { ...base, ...cuerpo });
  return validate(dto);
}

describe('ConfirmarParadaDto · estado_producto (API-10)', () => {
  it.each(['BUENO', 'REGULAR', 'MALO'])('acepta %s', async (estado) => {
    expect(await errores({ estado_producto: estado })).toHaveLength(0);
  });

  it('es opcional', async () => {
    expect(await errores({})).toHaveLength(0);
  });

  it.each(['EXCELENTE', 'bueno', 3])('rechaza %p', async (estado) => {
    const resultado = await errores({ estado_producto: estado });
    expect(resultado.map((e) => e.property)).toEqual(['estado_producto']);
  });
});
