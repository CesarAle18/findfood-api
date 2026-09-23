import { randomUUID } from 'node:crypto';
import { fechaBogota } from '../../src/comun/tiempo';
import type { ContextoPruebas, Cuenta } from './app-de-pruebas';

export interface Catalogos {
  tipo: (codigo: string) => number;
  motivo: (ambito: string, codigo: string) => number;
  tipoIncidencia: (codigo: string) => number;
  destino: (codigo: string) => number;
}

export async function catalogos(
  ctx: ContextoPruebas,
  cuenta: Cuenta,
): Promise<Catalogos> {
  type Fila = { id: number; codigo: string; ambito?: string };
  const { body } = await ctx.como(cuenta).get('/v1/catalogos').expect(200);
  const buscar = (lista: Fila[], codigo: string, ambito?: string) => {
    const item = lista.find(
      (f) =>
        f.codigo === codigo && (ambito === undefined || f.ambito === ambito),
    );
    if (!item) throw new Error(`Catálogo sin ${codigo}`);
    return item.id;
  };
  return {
    tipo: (codigo) => buscar(body.tipos_alimento, codigo),
    motivo: (ambito, codigo) => buscar(body.motivos, codigo, ambito),
    tipoIncidencia: (codigo) => buscar(body.tipos_incidencia, codigo),
    destino: (codigo) => buscar(body.tipos_destino_distribucion, codigo),
  };
}

/**
 * Banco (único, se crea o actualiza) y dos sedes propias de la zona de la
 * prueba. Cada archivo usa una zona distinta para no interferir con los demás.
 */
export async function prepararBanco(
  ctx: ContextoPruebas,
  admin: Cuenta,
  zona: { lat: number; lng: number },
): Promise<{ seco: string; refrigerado: string }> {
  await ctx
    .como(admin)
    .put('/v1/admin/banco')
    .send({
      nombre: 'Banco de Alimentos de Bogotá (pruebas)',
      direccion: 'Calle 19 # 32-50',
      ciudad: 'Bogotá',
      ubicacion: { lat: 4.6097, lng: -74.0817 },
      tiene_flota_propia: true,
    })
    .expect(200);
  const sede = async (tipo: 'SECO' | 'REFRIGERADO', delta: number) => {
    const r = await ctx
      .como(admin)
      .post('/v1/almacenes')
      .send({
        nombre: `Sede ${tipo} ${randomUUID().slice(0, 6)}`,
        direccion: 'Carrera 7 # 10-20',
        ciudad: 'Bogotá',
        ubicacion: { lat: zona.lat + delta, lng: zona.lng + delta },
        horario_disponibilidad: { lunes_a_sabado: ['07:00-18:00'] },
        tipo,
        capacidad_kg: 5000,
        ...(tipo === 'REFRIGERADO'
          ? { temperatura_min: 0, temperatura_max: 6 }
          : {}),
      })
      .expect(201);
    return r.body.id as string;
  };
  return {
    seco: await sede('SECO', 0.01),
    refrigerado: await sede('REFRIGERADO', -0.01),
  };
}

/** Fecha civil en Bogotá dentro de `dias` (la API razona en esa zona, no en UTC). */
export function enDias(dias: number): string {
  return fechaBogota(new Date(Date.now() + dias * 86_400_000));
}
