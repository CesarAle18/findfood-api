import { type Calculo, RECALCULO_MS, vigente } from './seguimiento.service';

describe('seguimiento: cuándo recalcular con Google', () => {
  const origen = { lat: 4.65, lng: -74.08 };
  const calculo: Calculo = {
    paradaId: 'p1',
    origen,
    at: 1_000_000,
    tramo: {
      trayecto: { type: 'LineString', coordinates: [] },
      distancia_km: 3,
      duracion_min: 9,
      llegada_estimada: '',
      proveedor: 'GOOGLE',
      calculado_at: '',
    },
  };

  it('reusa el cálculo reciente para la misma parada aunque el vehículo avance', () => {
    expect(vigente(calculo, 'p1', { lat: 4.655, lng: -74.08 }, 1_000_000 + 60_000)).toBe(true);
  });

  it('recalcula sin cálculo previo, al cambiar de parada o al vencer el plazo', () => {
    expect(vigente(undefined, 'p1', origen, 1_000_000)).toBe(false);
    expect(vigente(calculo, 'p2', origen, 1_000_000)).toBe(false);
    expect(vigente(calculo, 'p1', origen, 1_000_000 + RECALCULO_MS)).toBe(false);
  });

  it('recalcula si el vehículo se desvió o la posición saltó más de 2 km', () => {
    expect(vigente(calculo, 'p1', { lat: 4.68, lng: -74.08 }, 1_000_000)).toBe(false);
  });
});
