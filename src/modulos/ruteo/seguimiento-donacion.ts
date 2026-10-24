/**
 * Ventana en la que el donante puede seguir al voluntario de su donación (API-06).
 *
 * Es la misma regla que fn_rt_es_donante_de_ruta (migración
 * 20261023000000_seguimiento_donante.sql), que autoriza el canal Realtime ruta:<id>:
 * si cambia una, cambia la otra. Ley 1581: el seguimiento termina cuando la donación
 * llega al banco.
 */

export type FaseSeguimiento = 'HACIA_RECOGIDA' | 'HACIA_BANCO';

/** Estados que deciden la ventana. `null` cuando la donación no tiene ruta o la ruta no tiene ENTREGA. */
export interface EstadosSeguimiento {
  ruta_estado: string | null;
  recogida_estado: string | null;
  entrega_estado: string | null;
  donacion_estado: string;
}

export interface VentanaDonante {
  activo: boolean;
  fase: FaseSeguimiento | null;
}

const DONACION_EN_CALLE = ['ASIGNADA', 'EN_RECOLECCION', 'EN_TRANSITO'];
const PARADA_ABIERTA = ['PENDIENTE', 'EN_SITIO'];

export function ventanaDonante(e: EstadosSeguimiento): VentanaDonante {
  const activo =
    e.ruta_estado === 'EN_CURSO' &&
    DONACION_EN_CALLE.includes(e.donacion_estado) &&
    e.entrega_estado !== null &&
    PARADA_ABIERTA.includes(e.entrega_estado) &&
    e.recogida_estado !== null &&
    [...PARADA_ABIERTA, 'COMPLETADA'].includes(e.recogida_estado);
  if (!activo) return { activo: false, fase: null };
  return {
    activo: true,
    fase: e.recogida_estado === 'COMPLETADA' ? 'HACIA_BANCO' : 'HACIA_RECOGIDA',
  };
}
