import { type EstadosSeguimiento, ventanaDonante } from './seguimiento-donacion';

describe('ventanaDonante: cuándo el donante ve al voluntario (igual que fn_rt_es_donante_de_ruta)', () => {
  const base: EstadosSeguimiento = {
    ruta_estado: 'EN_CURSO',
    recogida_estado: 'PENDIENTE',
    entrega_estado: 'PENDIENTE',
    donacion_estado: 'ASIGNADA',
    otras_recogidas_abiertas: 0,
  };

  it.each<[string, Partial<EstadosSeguimiento>, 'HACIA_RECOGIDA' | 'HACIA_BANCO']>([
    ['recogida pendiente', {}, 'HACIA_RECOGIDA'],
    ['voluntario en el punto de recogida', { recogida_estado: 'EN_SITIO', donacion_estado: 'EN_RECOLECCION' }, 'HACIA_RECOGIDA'],
    ['recogida pendiente con otras recogidas antes', { otras_recogidas_abiertas: 2 }, 'HACIA_RECOGIDA'],
    ['recogida hecha, camino al banco', { recogida_estado: 'COMPLETADA', donacion_estado: 'EN_TRANSITO' }, 'HACIA_BANCO'],
    ['voluntario ya en el banco', { recogida_estado: 'COMPLETADA', donacion_estado: 'EN_TRANSITO', entrega_estado: 'EN_SITIO' }, 'HACIA_BANCO'],
  ])('activo y con posición: %s', (_caso, cambios, fase) => {
    expect(ventanaDonante({ ...base, ...cambios })).toEqual({
      activo: true,
      fase,
      posicion_visible: true,
    });
  });

  it.each<[string, number]>([
    ['una recogida ajena abierta', 1],
    ['varias recogidas ajenas abiertas', 3],
  ])('camino al banco con %s: activo, sin posición', (_caso, otras) => {
    expect(
      ventanaDonante({
        ...base,
        recogida_estado: 'COMPLETADA',
        donacion_estado: 'EN_TRANSITO',
        otras_recogidas_abiertas: otras,
      }),
    ).toEqual({ activo: true, fase: 'HACIA_BANCO', posicion_visible: false });
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
    expect(ventanaDonante({ ...base, ...cambios })).toEqual({
      activo: false,
      fase: null,
      posicion_visible: false,
    });
  });
});
