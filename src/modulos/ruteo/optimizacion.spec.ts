import {
  costoViaje,
  dosOpt,
  fuerzaBruta,
  optimizarRuta,
  type ProblemaRuta,
  simular,
  vecinoMasCercano,
} from './optimizacion';

/** Generador pseudoaleatorio determinista (mulberry32) para instancias reproducibles. */
function aleatorio(semilla: number) {
  let a = semilla;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Instancia euclidiana en un cuadrado de 10 km a 20 km/h, con asimetría leve (tráfico). */
function instancia(
  n: number,
  azar: () => number,
  ventanas = false,
): ProblemaRuta {
  const puntos = Array.from({ length: n + 2 }, () => [
    azar() * 10,
    azar() * 10,
  ]);
  const duraciones = puntos.map((a, i) =>
    puntos.map((b, j) =>
      i === j
        ? 0
        : (Math.hypot(a[0] - b[0], a[1] - b[1]) / 20) *
          60 *
          (0.9 + azar() * 0.2),
    ),
  );
  return {
    duraciones,
    ventanas: Array.from({ length: n }, () =>
      ventanas
        ? { inicioMin: azar() * 30, finMin: 60 + azar() * 90 }
        : { inicioMin: 0, finMin: 10_000 },
    ),
    servicioMin: 5,
  };
}

describe('orden de paradas (§8.2)', () => {
  it('con una sola recogida el orden es trivial', () => {
    const p = instancia(1, aleatorio(1));
    expect(optimizarRuta(p).orden).toEqual([1]);
  });

  it('vecino más cercano visita cada recogida una vez', () => {
    const p = instancia(5, aleatorio(2));
    expect([...vecinoMasCercano(p)].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it('2-opt nunca empeora el vecino más cercano', () => {
    const azar = aleatorio(3);
    for (let k = 0; k < 50; k++) {
      const p = instancia(5, azar);
      const nn = vecinoMasCercano(p);
      expect(costoViaje(dosOpt(nn, p), p)).toBeLessThanOrEqual(
        costoViaje(nn, p) + 1e-9,
      );
    }
  });

  it('respeta las ventanas: espera si llega temprano y marca infactible si llega tarde', () => {
    const p: ProblemaRuta = {
      duraciones: [
        [0, 10, 20],
        [10, 0, 10],
        [20, 10, 0],
      ],
      ventanas: [{ inicioMin: 30, finMin: 40 }],
      servicioMin: 5,
    };
    expect(simular([1], p)).toEqual({
      llegadasMin: [30, 45],
      totalMin: 45,
      factible: true,
    });
    p.ventanas[0].finMin = 5;
    expect(simular([1], p).factible).toBe(false);
    expect(optimizarRuta(p).metodo).toBe('INFACTIBLE');
  });

  it('si 2-opt incumple una ventana, busca la mejor permutación factible', () => {
    // La recogida 2 está lejos pero cierra pronto: hay que ir primero allá.
    const p: ProblemaRuta = {
      duraciones: [
        [0, 5, 30, 20],
        [5, 0, 30, 20],
        [30, 30, 0, 20],
        [20, 20, 20, 0],
      ],
      ventanas: [
        { inicioMin: 0, finMin: 500 },
        { inicioMin: 0, finMin: 31 },
      ],
      servicioMin: 0,
    };
    const r = optimizarRuta(p);
    expect(r.metodo).toBe('PERMUTACION_FACTIBLE');
    expect(r.orden).toEqual([2, 1]);
    expect(r.factible).toBe(true);
  });

  /**
   * Benchmark del criterio de calidad de ruta (§3.2): con la misma matriz,
   * vecino más cercano + 2-opt queda a ≤ 10 % del óptimo en rutas de 2 a 5
   * paradas. Se reporta la desviación media y el peor caso.
   */
  it('[§3.2] vecino más cercano + 2-opt queda a ≤ 10 % del óptimo (2 a 5 paradas)', () => {
    const azar = aleatorio(20260922);
    const desviaciones: number[] = [];
    for (let n = 2; n <= 5; n++) {
      for (let k = 0; k < 250; k++) {
        const p = instancia(n, azar);
        const heuristica = costoViaje(dosOpt(vecinoMasCercano(p), p), p);
        const optimo = fuerzaBruta(p, 'viaje')!.costo;
        desviaciones.push((heuristica - optimo) / optimo);
      }
    }
    const media = desviaciones.reduce((s, d) => s + d, 0) / desviaciones.length;
    const peor = Math.max(...desviaciones);
    // Visible al correr la prueba; útil para el informe del benchmark.
    process.stdout.write(
      `  benchmark ruteo: ${desviaciones.length} instancias, desviación media ${(media * 100).toFixed(2)} %, peor ${(peor * 100).toFixed(2)} %\n`,
    );
    expect(media).toBeLessThanOrEqual(0.1);
  });
});
