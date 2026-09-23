/**
 * Orden de paradas de una ruta (§8.2). Índices de la matriz de duraciones:
 *   0        → punto de partida (voluntario o banco)
 *   1 … N    → recogidas
 *   N + 1    → sede de entrega
 * Un "orden" es una permutación de 1 … N; la ruta siempre empieza en 0 y
 * termina en N + 1. Todo en minutos, relativo a la hora de salida.
 */

export interface VentanaRelativa {
  inicioMin: number;
  finMin: number;
}

export interface ProblemaRuta {
  /** Matriz (N+2)×(N+2) de duraciones en minutos (puede ser asimétrica). */
  duraciones: number[][];
  /** Ventana de cada recogida: ventanas[i - 1] corresponde al índice i. */
  ventanas: VentanaRelativa[];
  /** Minutos que toma cada recogida en sitio. */
  servicioMin: number;
}

export interface Simulacion {
  /** Llegada estimada a cada recogida, en el orden visitado, y al final a la sede. */
  llegadasMin: number[];
  totalMin: number;
  factible: boolean;
}

export interface RutaOptimizada extends Simulacion {
  orden: number[];
  metodo: 'VECINO_MAS_CERCANO_2OPT' | 'PERMUTACION_FACTIBLE' | 'INFACTIBLE';
}

function n(p: ProblemaRuta): number {
  return p.duraciones.length - 2;
}

/** Suma de duraciones de viaje (sin esperas ni servicio): lo que minimiza 2-opt. */
export function costoViaje(orden: number[], p: ProblemaRuta): number {
  const secuencia = [0, ...orden, n(p) + 1];
  let total = 0;
  for (let i = 1; i < secuencia.length; i++) {
    total += p.duraciones[secuencia[i - 1]][secuencia[i]];
  }
  return total;
}

/** Recorre la ruta: espera si llega antes de la ventana, infactible si llega después. */
export function simular(orden: number[], p: ProblemaRuta): Simulacion {
  let t = 0;
  let previo = 0;
  let factible = true;
  const llegadasMin: number[] = [];
  for (const i of orden) {
    t += p.duraciones[previo][i];
    const ventana = p.ventanas[i - 1];
    if (t < ventana.inicioMin) t = ventana.inicioMin;
    if (t > ventana.finMin) factible = false;
    llegadasMin.push(t);
    t += p.servicioMin;
    previo = i;
  }
  t += p.duraciones[previo][n(p) + 1];
  llegadasMin.push(t);
  return { llegadasMin, totalMin: t, factible };
}

export function vecinoMasCercano(p: ProblemaRuta): number[] {
  const pendientes = new Set(Array.from({ length: n(p) }, (_v, i) => i + 1));
  const orden: number[] = [];
  let actual = 0;
  while (pendientes.size) {
    let mejor = -1;
    for (const j of pendientes) {
      if (mejor === -1 || p.duraciones[actual][j] < p.duraciones[actual][mejor])
        mejor = j;
    }
    orden.push(mejor);
    pendientes.delete(mejor);
    actual = mejor;
  }
  return orden;
}

/** 2-opt con extremos fijos, hasta que ningún intercambio mejore. */
export function dosOpt(inicial: number[], p: ProblemaRuta): number[] {
  let orden = [...inicial];
  let mejorCosto = costoViaje(orden, p);
  let mejoro = true;
  while (mejoro) {
    mejoro = false;
    for (let i = 0; i < orden.length - 1; i++) {
      for (let k = i + 1; k < orden.length; k++) {
        const candidato = [
          ...orden.slice(0, i),
          ...orden.slice(i, k + 1).reverse(),
          ...orden.slice(k + 1),
        ];
        const costo = costoViaje(candidato, p);
        if (costo < mejorCosto - 1e-9) {
          orden = candidato;
          mejorCosto = costo;
          mejoro = true;
        }
      }
    }
  }
  return orden;
}

function* permutaciones(elementos: number[]): Generator<number[]> {
  if (elementos.length <= 1) {
    yield [...elementos];
    return;
  }
  for (let i = 0; i < elementos.length; i++) {
    const resto = [...elementos.slice(0, i), ...elementos.slice(i + 1)];
    for (const p of permutaciones(resto)) yield [elementos[i], ...p];
  }
}

/**
 * Fuerza bruta: con N ≤ 5 son a lo sumo 120 permutaciones. Es el óptimo de
 * referencia del benchmark (§8.2) y el respaldo cuando 2-opt incumple ventanas.
 */
export function fuerzaBruta(
  p: ProblemaRuta,
  criterio: 'viaje' | 'factible',
): { orden: number[]; costo: number } | null {
  let mejor: { orden: number[]; costo: number } | null = null;
  const base = Array.from({ length: n(p) }, (_v, i) => i + 1);
  for (const orden of permutaciones(base)) {
    let costo: number;
    if (criterio === 'viaje') {
      costo = costoViaje(orden, p);
    } else {
      const sim = simular(orden, p);
      if (!sim.factible) continue;
      costo = sim.totalMin;
    }
    if (!mejor || costo < mejor.costo) mejor = { orden, costo };
  }
  return mejor;
}

export function optimizarRuta(p: ProblemaRuta): RutaOptimizada {
  if (n(p) === 0) {
    return { orden: [], metodo: 'VECINO_MAS_CERCANO_2OPT', ...simular([], p) };
  }
  const heuristica = dosOpt(vecinoMasCercano(p), p);
  const sim = simular(heuristica, p);
  if (sim.factible)
    return { orden: heuristica, metodo: 'VECINO_MAS_CERCANO_2OPT', ...sim };

  const alternativa = fuerzaBruta(p, 'factible');
  if (alternativa) {
    return {
      orden: alternativa.orden,
      metodo: 'PERMUTACION_FACTIBLE',
      ...simular(alternativa.orden, p),
    };
  }
  return { orden: heuristica, metodo: 'INFACTIBLE', ...sim };
}
