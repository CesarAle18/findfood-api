import { type EstadosSeguimiento, ventanaDonante } from './seguimiento-donacion';

describe('ventanaDonante: cuándo el donante ve al voluntario (igual que fn_rt_es_donante_de_ruta)', () => {
  const base: EstadosSeguimiento = {
    ruta_estado: 'EN_CURSO',
    recogida_estado: 'PENDIENTE',
    entrega_estado: 'PENDIENTE',
    donacion_estado: 'ASIGNADA',
  };

  it.each<[string, Partial<EstadosSeguimiento>, 'HACIA_RECOGIDA' | 'HACIA_BANCO']>([
    ['recogida pendiente', {}, 'HACIA_RECOGIDA'],
    ['voluntario en el punto de recogida', { recogida_estado: 'EN_SITIO', donacion_estado: 'EN_RECOLECCION' }, 'HACIA_RECOGIDA'],
    ['recogida hecha, camino al banco', { recogida_estado: 'COMPLETADA', donacion_estado: 'EN_TRANSITO' }, 'HACIA_BANCO'],
    ['voluntario ya en el banco', { recogida_estado: 'COMPLETADA', donacion_estado: 'EN_TRANSITO', entrega_estado: 'EN_SITIO' }, 'HACIA_BANCO'],
  ])('activo: %s', (_caso, cambios, fase) => {
    expect(ventanaDonante({ ...base, ...cambios })).toEqual({ activo: true, fase });
  });

  it.each<[string, Partial<EstadosSeguimiento>]>([
    ['ruta planificada sin iniciar', { ruta_estado: 'PLANIFICADA' }],
    ['ruta completada', { ruta_estado: 'COMPLETADA', recogida_estado: 'COMPLETADA', entrega_estado: 'COMPLETADA' }],
    ['ruta cancelada', { ruta_estado: 'CANCELADA' }],
    ['recogida fallida', { recogida_estado: 'FALLIDA' }],
    ['recogida omitida', { recogida_estado: 'OMITIDA' }],
    ['donación entregada', { recogida_estado: 'COMPLETADA', donacion_estado: 'ENTREGADA' }],
    ['donación cancelada', { donacion_estado: 'CANCELADA' }],
    ['entrega ya confirmada', { recogida_estado: 'COMPLETADA', entrega_estado: 'COMPLETADA', donacion_estado: 'EN_TRANSITO' }],
    ['sin parada de entrega', { entrega_estado: null }],
    ['sin ruta', { ruta_estado: null, recogida_estado: null, entrega_estado: null }],
  ])('inactivo: %s', (_caso, cambios) => {
    expect(ventanaDonante({ ...base, ...cambios })).toEqual({ activo: false, fase: null });
  });
});
