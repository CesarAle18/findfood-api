import {
  ajusteCarga,
  type ContextoPuntaje,
  type EntradaCandidato,
  puntuarCandidatos,
  tasaConfiabilidad,
} from './puntaje';

const contexto: ContextoPuntaje = {
  pesoDonacionKg: 60,
  minutosHastaFinVentana: 120,
  radioKm: 10,
  pesos: {
    proximidad: 0.35,
    urgencia: 0.25,
    confiabilidad: 0.25,
    holgura: 0.15,
  },
};

const candidato = (
  id: string,
  parcial: Partial<EntradaCandidato> = {},
): EntradaCandidato => ({
  voluntarioId: id,
  distanciaKm: 2,
  etaMin: 6,
  capacidadKg: 100,
  completadas: 0,
  aceptadas: 0,
  ...parcial,
});

describe('puntaje multicriterio (§6.4)', () => {
  it('a igualdad de lo demás, gana el más próximo', () => {
    const [primero, segundo] = puntuarCandidatos(
      [
        candidato('lejos', { distanciaKm: 8, etaMin: 24 }),
        candidato('cerca', { distanciaKm: 1, etaMin: 3 }),
      ],
      contexto,
    );
    expect(primero.voluntarioId).toBe('cerca');
    expect(primero.score).toBeGreaterThan(segundo.score);
  });

  it('descarta a quien no alcanza a llegar antes del cierre de la ventana (holgura negativa)', () => {
    const r = puntuarCandidatos(
      [
        candidato('tarde', { etaMin: 121 }),
        candidato('a-tiempo', { etaMin: 30 }),
      ],
      contexto,
    );
    expect(r.map((c) => c.voluntarioId)).toEqual(['a-tiempo']);
  });

  it('si todos valen lo mismo en un criterio min–max, ese criterio vale 1 para todos', () => {
    const r = puntuarCandidatos([candidato('a'), candidato('b')], contexto);
    expect(
      r.every(
        (c) =>
          c.componentes.urgencia === 1 && c.componentes.confiabilidad === 1,
      ),
    ).toBe(true);
    expect(r[0].score).toBe(r[1].score);
  });

  it('proximidad con referencia fija: recorrer el radio completo vale 0', () => {
    const [c] = puntuarCandidatos(
      [candidato('borde', { etaMin: 30 })],
      contexto,
    );
    expect(c.componentes.proximidad).toBe(0);
  });

  it('confiabilidad: los rechazos no cuentan; los abandonos sí', () => {
    expect(tasaConfiabilidad(0, 0)).toBeCloseTo(0.8);
    expect(tasaConfiabilidad(10, 10)).toBeGreaterThan(tasaConfiabilidad(0, 0));
    expect(tasaConfiabilidad(5, 10)).toBeLessThan(tasaConfiabilidad(0, 0));
  });

  it('holgura de carga: óptima en r* = 0,6 y penaliza sub y sobreutilización', () => {
    expect(ajusteCarga(60, 100)).toBeCloseTo(1);
    expect(ajusteCarga(10, 100)).toBeLessThan(ajusteCarga(50, 100));
    expect(ajusteCarga(100, 100)).toBeLessThan(ajusteCarga(70, 100));
  });

  it('el score está en [0, 1] cuando los pesos suman 1', () => {
    const r = puntuarCandidatos(
      [
        candidato('a', { etaMin: 1, completadas: 9, aceptadas: 9 }),
        candidato('b', {
          etaMin: 20,
          completadas: 0,
          aceptadas: 4,
          capacidadKg: 3000,
        }),
      ],
      contexto,
    );
    for (const c of r) {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(1);
    }
  });
});
