export interface EntradaUrgencia {
  /** Vencimiento más próximo de los productos, 'YYYY-MM-DD'; null si no hay perecederos. */
  fechaVencimientoMin: string | null;
  requiereRefrigeracion: boolean;
  ventanaFin: Date;
  ahora: Date;
}

/** Bogotá no tiene horario de verano: siempre UTC−5. */
const FIN_DEL_DIA_BOGOTA = 'T23:59:59-05:00';

/**
 * score_urgencia de la donación (§6.5), con referencias fijas para que sea
 * comparable entre donaciones:
 *   0,6 · (1 − min(1, horas_hasta_vencimiento / 72))
 * + 0,2 · [requiere_refrigeracion]
 * + 0,2 · (1 − min(1, minutos_hasta_fin_de_ventana / 240))
 */
export function scoreUrgencia(e: EntradaUrgencia): number {
  let vencimiento = 0;
  if (e.fechaVencimientoMin) {
    const vence = new Date(`${e.fechaVencimientoMin}${FIN_DEL_DIA_BOGOTA}`);
    const horas = Math.max(
      0,
      (vence.getTime() - e.ahora.getTime()) / 3_600_000,
    );
    vencimiento = 1 - Math.min(1, horas / 72);
  }
  const frio = e.requiereRefrigeracion ? 1 : 0;
  const minutos = Math.max(
    0,
    (e.ventanaFin.getTime() - e.ahora.getTime()) / 60_000,
  );
  const ventana = 1 - Math.min(1, minutos / 240);
  return (
    Math.round((0.6 * vencimiento + 0.2 * frio + 0.2 * ventana) * 1000) / 1000
  );
}
