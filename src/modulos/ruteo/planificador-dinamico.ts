import { optimizarRuta, type RutaOptimizada } from './optimizacion';

/** Núcleo puro: decide el orden del tramo todavía modificable de una ruta. */
export type EstadoParadaDinamica =
  | 'PENDIENTE' | 'EN_SITIO' | 'COMPLETADA' | 'FALLIDA' | 'OMITIDA';

export interface RecogidaDinamica {
  id: string;
  donacionId: string;
  estado: EstadoParadaDinamica;
  orden: number;
  pesoEstimadoKg: number;
  pesoRealKg?: number | null;
  ventanaInicio: Date;
  ventanaFin: Date;
}

export interface DatosPlanDinamico {
  ahora: Date;
  sedeRutaId: string;
  sedeDonacionId: string;
  capacidadKg: number;
  maxRecogidas: number;
  recogidas: RecogidaDinamica[];
  nueva: Omit<RecogidaDinamica, 'estado' | 'orden'>;
  /** [origen, ...recogidas pendientes, sede]. Construir fuera de la transacción. */
  duracionesMin: number[][];
  servicioMin: number;
  /** true cuando la entrega ya está EN_SITIO o cerrada. */
  entregaIniciada: boolean;
}

export type PlanDinamico =
  | { viable: true; ordenDonacionesPendientes: string[]; llegadasMin: number[];
      duracionEstimadaMin: number; metodo: RutaOptimizada['metodo'];
      idsHistoricosInmutables: string[]; paradaEnSitioId: string | null }
  | { viable: false; codigo: string; motivo: string };

const falla = (codigo: string, motivo: string): PlanDinamico => ({viable: false, codigo, motivo});

export function planificarRutaDinamica(datos: DatosPlanDinamico): PlanDinamico {
  const { recogidas, nueva, ahora } = datos;
  if (datos.sedeRutaId !== datos.sedeDonacionId)
    return falla('RUTA_SEDE_DISTINTA', 'La nueva donación debe entregarse en la misma sede');
  if (datos.entregaIniciada)
    return falla('RUTA_ENTREGA_INICIADA', 'No se añaden recogidas después de iniciar la entrega');
  if (recogidas.some(p => p.donacionId === nueva.donacionId))
    return falla('DONACION_YA_EN_RUTA', 'La donación ya pertenece a la ruta');
  if (recogidas.length + 1 > datos.maxRecogidas)
    return falla('RUTA_SIN_CUPOS', 'Se alcanzó el máximo de recogidas permitidas');
  if (nueva.ventanaFin.getTime() <= ahora.getTime())
    return falla('VENTANA_CERRADA', 'La ventana de la nueva donación ya terminó');
  if (!(datos.capacidadKg > 0) || nueva.pesoEstimadoKg < 0)
    return falla('CAPACIDAD_INVALIDA', 'Capacidad o peso no válido');

  // El peso recogido ocupa espacio hasta la única entrega final.
  // Incluye recogidas cerradas y las todavía comprometidas.
  const comprometido = recogidas.reduce((s, p) => {
    if (p.estado === 'FALLIDA' || p.estado === 'OMITIDA') return s;
    if (p.estado === 'COMPLETADA') return s + (p.pesoRealKg ?? p.pesoEstimadoKg);
    return s + p.pesoEstimadoKg;
  }, 0);
  if (comprometido + nueva.pesoEstimadoKg > datos.capacidadKg)
    return falla('RUTA_SIN_CAPACIDAD', 'El peso comprometido excede la capacidad de carga');

  const enSitio = recogidas.filter(p => p.estado === 'EN_SITIO');
  if (enSitio.length > 1)
    return falla('RUTA_ESTADO_INCONSISTENTE', 'Hay más de una recogida en sitio');
  // Una recogida EN_SITIO no puede reordenarse. El llamador debe partir del
  // punto de origen posterior a su atención y no modificar esa fila.
  const pendientes = recogidas.filter(p => p.estado === 'PENDIENTE').sort((a,b) => a.orden-b.orden);
  const seleccion = [...pendientes, { ...nueva, estado: 'PENDIENTE' as const, orden: Number.MAX_SAFE_INTEGER }];
  const n = seleccion.length + 2;
  if (datos.duracionesMin.length !== n || datos.duracionesMin.some(r => r.length !== n || r.some(x => !Number.isFinite(x) || x < 0)))
    return falla('MATRIZ_INVALIDA', `Se requiere una matriz ${n}×${n} con tiempos válidos`);
  const ventanas = seleccion.map(p => ({
    inicioMin: (p.ventanaInicio.getTime() - ahora.getTime()) / 60000,
    finMin: (p.ventanaFin.getTime() - ahora.getTime()) / 60000,
  }));
  const resultado = optimizarRuta({duraciones:datos.duracionesMin, ventanas, servicioMin:datos.servicioMin});
  if (!resultado.factible || resultado.metodo === 'INFACTIBLE')
    return falla('RUTA_NO_FACTIBLE', 'No existe un orden que respete las ventanas de recogida');
  return {
    viable:true,
    ordenDonacionesPendientes:resultado.orden.map(i => seleccion[i-1].donacionId),
    llegadasMin:resultado.llegadasMin,
    duracionEstimadaMin:resultado.totalMin,
    metodo:resultado.metodo,
    idsHistoricosInmutables:recogidas.filter(p => p.estado !== 'PENDIENTE').map(p => p.id),
    paradaEnSitioId:enSitio[0]?.id ?? null,
  };
}
