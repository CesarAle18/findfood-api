/**
 * Ventana en la que el donante puede seguir al voluntario de su donación (API-06).
 *
 * Es la misma regla que fn_rt_es_donante_de_ruta (migraciones
 * 20261023000000_seguimiento_donante.sql y 20261023000001_seguimiento_donante_privacidad.sql),
 * que autoriza el canal Realtime ruta:<id>: si cambia una, cambia la otra. Ley 1581: el
 * seguimiento termina cuando la donación llega al banco.
 */

export type FaseSeguimiento = 'HACIA_RECOGIDA' | 'HACIA_BANCO';

/** Estados que deciden la ventana. `null` cuando la donación no tiene ruta o la ruta no tiene ENTREGA. */
export interface EstadosSeguimiento {
  ruta_estado: string | null;
  recogida_estado: string | null;
  /** La ENTREGA de mayor `orden` de la ruta (la llegada al banco). */
  entrega_estado: string | null;
  donacion_estado: string;
  /** Otras paradas RECOGIDA de la ruta que siguen abiertas (PENDIENTE o EN_SITIO). */
  otras_recogidas_abiertas: number;
}

export interface VentanaDonante {
  /** El donante ve la sección de seguimiento (fase, su punto, el banco, `paradas_antes`). */
  activo: boolean;
  fase: FaseSeguimiento | null;
  /**
   * Puede ver dónde va el voluntario (posición, tramo y canal Realtime). Camino al banco
   * se oculta mientras el voluntario tenga recogidas de otros donantes por hacer: su
   * posición en una de ellas revelaría la dirección de ese donante.
   */
  posicion_visible: boolean;
}

const DONACION_EN_CALLE = ['ASIGNADA', 'EN_RECOLECCION', 'EN_TRANSITO'];
/** Estados de una parada que aún no se resuelve. También los usa la consulta del seguimiento. */
export const PARADA_ABIERTA = ['PENDIENTE', 'EN_SITIO'];

export function ventanaDonante(e: EstadosSeguimiento): VentanaDonante {
  const activo =
    e.ruta_estado === 'EN_CURSO' &&
    DONACION_EN_CALLE.includes(e.donacion_estado) &&
    e.entrega_estado !== null &&
    PARADA_ABIERTA.includes(e.entrega_estado) &&
    e.recogida_estado !== null &&
    [...PARADA_ABIERTA, 'COMPLETADA'].includes(e.recogida_estado);
  if (!activo) return { activo: false, fase: null, posicion_visible: false };
  if (e.recogida_estado !== 'COMPLETADA') {
    return { activo: true, fase: 'HACIA_RECOGIDA', posicion_visible: true };
  }
  return {
    activo: true,
    fase: 'HACIA_BANCO',
    posicion_visible: e.otras_recogidas_abiertas === 0,
  };
}
