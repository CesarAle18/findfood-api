import { planificarRutaDinamica } from './planificador-dinamico';

const ahora = new Date('2026-10-21T10:00:00.000Z');
const nueva = { id:'p2', donacionId:'d2', pesoEstimadoKg: 2,
  ventanaInicio: new Date(ahora.getTime() - 60_000),
  ventanaFin: new Date(ahora.getTime() + 3_600_000) };
const base = {
  ahora, sedeRutaId:'s1', sedeDonacionId:'s1', capacidadKg:10,
  maxRecogidas:5, servicioMin:5, entregaIniciada:false,
  recogidas:[{ id:'p1', donacionId:'d1', estado:'PENDIENTE' as const, orden:1,
    pesoEstimadoKg:3, ventanaInicio:nueva.ventanaInicio, ventanaFin:nueva.ventanaFin }],
  nueva,
  duracionesMin:[[0,5,6,12],[5,0,4,6],[6,4,0,7],[12,6,7,0]],
};

describe('planificarRutaDinamica', () => {
  it('incorpora dos recogidas en una única sede', () => {
    const r = planificarRutaDinamica(base);
    expect(r.viable).toBe(true);
    if (r.viable) expect(new Set(r.ordenDonacionesPendientes)).toEqual(new Set(['d1','d2']));
  });
  it('rechaza una sede diferente', () => {
    const r = planificarRutaDinamica({...base, sedeDonacionId:'s2'});
    expect(r).toMatchObject({viable:false,codigo:'RUTA_SEDE_DISTINTA'});
  });
  it('tiene en cuenta kilos ya recogidos', () => {
    const r = planificarRutaDinamica({...base, capacidadKg:4,
      recogidas:[{...base.recogidas[0], estado:'COMPLETADA' as const, pesoRealKg:3}],
      duracionesMin:[[0,5,12],[5,0,6],[12,6,0]]});
    expect(r).toMatchObject({viable:false,codigo:'RUTA_SIN_CAPACIDAD'});
  });
  it('no reordena paradas completadas', () => {
    const r = planificarRutaDinamica({...base,
      recogidas:[{...base.recogidas[0],estado:'COMPLETADA' as const}],
      duracionesMin:[[0,5,12],[5,0,6],[12,6,0]]});
    expect(r.viable).toBe(true);
    if (r.viable) {
      expect(r.idsHistoricosInmutables).toContain('p1');
      expect(r.ordenDonacionesPendientes).toEqual(['d2']);
    }
  });
  it('rechaza cuando la entrega inició', () => {
    expect(planificarRutaDinamica({...base,entregaIniciada:true}))
      .toMatchObject({viable:false,codigo:'RUTA_ENTREGA_INICIADA'});
  });
});
