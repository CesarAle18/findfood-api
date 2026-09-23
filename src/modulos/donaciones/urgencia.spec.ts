import { scoreUrgencia } from './urgencia';

const ahora = new Date('2026-09-22T15:00:00-05:00');
const horas = (h: number) => new Date(ahora.getTime() + h * 3_600_000);

describe('score_urgencia (§6.5)', () => {
  it('no perecedero, sin frío y con ventana amplia: 0', () => {
    expect(
      scoreUrgencia({
        fechaVencimientoMin: null,
        requiereRefrigeracion: false,
        ventanaFin: horas(8),
        ahora,
      }),
    ).toBe(0);
  });

  it('refrigeración suma 0,2', () => {
    expect(
      scoreUrgencia({
        fechaVencimientoMin: null,
        requiereRefrigeracion: true,
        ventanaFin: horas(8),
        ahora,
      }),
    ).toBe(0.2);
  });

  it('vence hoy (fin del día en Bogotá): el término de vencimiento pesa casi 0,6', () => {
    const s = scoreUrgencia({
      fechaVencimientoMin: '2026-09-22',
      requiereRefrigeracion: false,
      ventanaFin: horas(8),
      ahora,
    });
    // Faltan 9 h hasta las 23:59:59: 0,6 · (1 − 9/72) ≈ 0,525.
    expect(s).toBeCloseTo(0.525, 2);
  });

  it('ventana a punto de cerrar suma hasta 0,2', () => {
    const s = scoreUrgencia({
      fechaVencimientoMin: null,
      requiereRefrigeracion: false,
      ventanaFin: horas(1),
      ahora,
    });
    expect(s).toBeCloseTo(0.2 * (1 - 60 / 240), 3);
  });

  it('el máximo es 1', () => {
    expect(
      scoreUrgencia({
        fechaVencimientoMin: '2026-09-21',
        requiereRefrigeracion: true,
        ventanaFin: ahora,
        ahora,
      }),
    ).toBe(1);
  });
});
