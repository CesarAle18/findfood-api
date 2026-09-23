import { minutosEstimados } from '../../comun/geo';

/**
 * Puntaje multicriterio s(v,d) = w₁·proximidad + w₂·urgencia + w₃·confiabilidad
 * + w₄·holgura_carga, con la propuesta de §6.4:
 *
 * - proximidad: normalización con referencia fija `1 − ETA / ETA_ref`, donde
 *   ETA_ref es recorrer el radio de búsqueda a la velocidad urbana de
 *   referencia (recomendación del documento: más estable que min–max).
 * - urgencia → holgura temporal: minutos entre la llegada estimada y el cierre
 *   de la ventana. Negativa = no alcanza a llegar: se descarta (filtro duro).
 * - confiabilidad: tasa con valor previo (completadas + α·p₀) / (aceptadas + α).
 *   Rechazar no la reduce; abandonar tras aceptar, sí.
 * - holgura de carga: 1 − |r − r*| / max(r*, 1 − r*), r = peso / capacidad.
 *
 * Holgura temporal, confiabilidad y carga se normalizan min–max dentro de F(d)
 * (si todos valen lo mismo, 1).
 */

export const CONFIABILIDAD_PRIOR = 0.8; // p₀
export const CONFIABILIDAD_ALFA = 5; // α
export const OCUPACION_IDEAL = 0.6; // r*

export interface PesosPuntaje {
  proximidad: number;
  urgencia: number;
  confiabilidad: number;
  holgura: number;
}

export interface EntradaCandidato {
  voluntarioId: string;
  distanciaKm: number;
  /** Minutos de viaje: Google (etapa 2) o geodésico en fallback. */
  etaMin: number;
  capacidadKg: number;
  completadas: number;
  /** Asignaciones aceptadas y ya resueltas: COMPLETADA + ABANDONADA. */
  aceptadas: number;
}

export interface ContextoPuntaje {
  pesoDonacionKg: number;
  minutosHastaFinVentana: number;
  radioKm: number;
  pesos: PesosPuntaje;
}

export interface CandidatoPuntuado extends EntradaCandidato {
  holguraMin: number;
  componentes: {
    proximidad: number;
    urgencia: number;
    confiabilidad: number;
    holgura_carga: number;
  };
  score: number;
}

export function tasaConfiabilidad(
  completadas: number,
  aceptadas: number,
): number {
  return (
    (completadas + CONFIABILIDAD_ALFA * CONFIABILIDAD_PRIOR) /
    (aceptadas + CONFIABILIDAD_ALFA)
  );
}

export function ajusteCarga(pesoKg: number, capacidadKg: number): number {
  const r = Math.min(1, Math.max(0, pesoKg / capacidadKg));
  return (
    1 -
    Math.abs(r - OCUPACION_IDEAL) /
      Math.max(OCUPACION_IDEAL, 1 - OCUPACION_IDEAL)
  );
}

function minMax(valores: number[]): (v: number) => number {
  const min = Math.min(...valores);
  const max = Math.max(...valores);
  return (v) => (max === min ? 1 : (v - min) / (max - min));
}

const redondear = (v: number, decimales = 3) =>
  Math.round(v * 10 ** decimales) / 10 ** decimales;

export function puntuarCandidatos(
  entradas: EntradaCandidato[],
  ctx: ContextoPuntaje,
): CandidatoPuntuado[] {
  const factibles = entradas
    .map((e) => ({ ...e, holguraMin: ctx.minutosHastaFinVentana - e.etaMin }))
    .filter((e) => e.holguraMin >= 0);
  if (!factibles.length) return [];

  const etaReferencia = Math.max(1, minutosEstimados(ctx.radioKm));
  const confiabilidades = factibles.map((e) =>
    tasaConfiabilidad(e.completadas, e.aceptadas),
  );
  const cargas = factibles.map((e) =>
    ajusteCarga(ctx.pesoDonacionKg, e.capacidadKg),
  );
  const normHolgura = minMax(factibles.map((e) => e.holguraMin));
  const normConfiabilidad = minMax(confiabilidades);
  const normCarga = minMax(cargas);

  return factibles
    .map((e, i): CandidatoPuntuado => {
      const componentes = {
        proximidad: 1 - Math.min(1, e.etaMin / etaReferencia),
        urgencia: normHolgura(e.holguraMin),
        confiabilidad: normConfiabilidad(confiabilidades[i]),
        holgura_carga: normCarga(cargas[i]),
      };
      const score =
        ctx.pesos.proximidad * componentes.proximidad +
        ctx.pesos.urgencia * componentes.urgencia +
        ctx.pesos.confiabilidad * componentes.confiabilidad +
        ctx.pesos.holgura * componentes.holgura_carga;
      return {
        ...e,
        componentes: {
          proximidad: redondear(componentes.proximidad),
          urgencia: redondear(componentes.urgencia),
          confiabilidad: redondear(componentes.confiabilidad),
          holgura_carga: redondear(componentes.holgura_carga),
        },
        score: redondear(score),
      };
    })
    .sort((a, b) => b.score - a.score || a.distanciaKm - b.distanciaKm);
}
