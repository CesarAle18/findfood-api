import { noProcesable } from './http/problema';
import type { Tx } from './prisma/prisma.service';

/** Rol de quien recibe la calificación (el donante califica al VOLUNTARIO). */
export type RolCalificado = 'DONANTE' | 'VOLUNTARIO';

export interface AspectoResuelto {
  id: number;
  codigo: string;
  nombre: string;
}

/**
 * Resuelve los códigos de aspecto contra el catálogo activo del rol calificado
 * (F-12). Un código desconocido, inactivo o de otro rol responde 422
 * `aspecto-invalido` con la lista en `codigos_invalidos`. Devuelve los
 * aspectos en el orden del catálogo.
 */
export async function validarAspectos(
  db: Pick<Tx, 'aspecto_calificacion'>,
  codigos: string[] | undefined,
  rol: RolCalificado,
): Promise<AspectoResuelto[]> {
  const pedidos = [...new Set(codigos ?? [])];
  if (!pedidos.length) return [];
  const aspectos = await db.aspecto_calificacion.findMany({
    where: { rol_calificado: rol, activo: true, codigo: { in: pedidos } },
    orderBy: { id: 'asc' },
    select: { id: true, codigo: true, nombre: true },
  });
  const validos = new Set(aspectos.map((a) => a.codigo));
  const invalidos = pedidos.filter((c) => !validos.has(c));
  if (invalidos.length) {
    throw noProcesable(
      'aspecto-invalido',
      'Aspecto de calificación no válido',
      `Los aspectos ${invalidos.join(', ')} no existen o no aplican a ${rol}`,
      { codigos_invalidos: invalidos },
    );
  }
  return aspectos;
}
