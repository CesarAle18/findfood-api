import type { ambito_motivo } from '../generated/prisma/enums';
import { noProcesable } from './http/problema';
import type { Tx } from './prisma/prisma.service';

/**
 * Valida un motivo del catálogo para un ámbito y exige el comentario si el
 * motivo lo declara obligatorio (motivo.requiere_comentario).
 */
export async function validarMotivo(
  db: Pick<Tx, 'motivo'>,
  motivoId: number,
  ambito: ambito_motivo,
  comentario?: string | null,
): Promise<{ id: number; nombre: string; codigo: string }> {
  const motivo = await db.motivo.findFirst({
    where: { id: motivoId, ambito, activo: true },
    select: { id: true, nombre: true, codigo: true, requiere_comentario: true },
  });
  if (!motivo) {
    throw noProcesable(
      'motivo-invalido',
      `El motivo no existe o no aplica a ${ambito}`,
    );
  }
  if (motivo.requiere_comentario && !comentario?.trim()) {
    throw noProcesable(
      'comentario-requerido',
      `El motivo "${motivo.nombre}" exige un comentario`,
    );
  }
  return { id: motivo.id, nombre: motivo.nombre, codigo: motivo.codigo };
}
