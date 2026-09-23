import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { ambito_entidad } from '../../generated/prisma/client';
import { Prisma } from '../../generated/prisma/client';
import { type Coordenada, sqlPuntoOpcional } from '../geo';
import type { Tx } from '../prisma/prisma.service';

export interface CambioEstado {
  ambito: ambito_entidad;
  /** Exactamente uno (ck_historial_padre). */
  entidad:
    | { donacionId: string }
    | { asignacionId: string }
    | { rutaId: string }
    | { paradaId: string }
    | { incidenciaId: string }
    | { loteId: string };
  anterior?: string | null;
  nuevo: string;
  usuarioId?: string | null;
  motivo?: string | null;
  metadata?: Record<string, unknown>;
  ubicacion?: Coordenada | null;
}

export interface RegistroAuditoria {
  usuarioId: string | null;
  accion: string;
  entidad: string;
  entidadId?: string;
  anteriores?: unknown;
  nuevos?: unknown;
  peticion?: Request;
}

/**
 * Historial de estados y bitácora. Siempre dentro de la transacción del cambio
 * que registran (§5.3): nunca hay transición sin trazabilidad.
 */
@Injectable()
export class TrazabilidadService {
  async registrar(tx: Tx, c: CambioEstado): Promise<void> {
    const e = c.entidad;
    await tx.$executeRaw`
      INSERT INTO historial_estado
        (ambito, donacion_id, asignacion_id, ruta_id, parada_id, incidencia_id, lote_id,
         estado_anterior, estado_nuevo, usuario_id, motivo, metadata, ubicacion)
      VALUES (
        ${c.ambito}::ambito_entidad,
        ${'donacionId' in e ? e.donacionId : null}::uuid,
        ${'asignacionId' in e ? e.asignacionId : null}::uuid,
        ${'rutaId' in e ? e.rutaId : null}::uuid,
        ${'paradaId' in e ? e.paradaId : null}::uuid,
        ${'incidenciaId' in e ? e.incidenciaId : null}::uuid,
        ${'loteId' in e ? e.loteId : null}::uuid,
        ${c.anterior ?? null},
        ${c.nuevo},
        ${c.usuarioId ?? null}::uuid,
        ${c.motivo ?? null},
        ${c.metadata ? JSON.stringify(c.metadata) : null}::jsonb,
        ${sqlPuntoOpcional(c.ubicacion)}
      )`;
  }

  async auditar(tx: Tx, r: RegistroAuditoria): Promise<void> {
    const ip = r.peticion?.ip?.replace(/^::ffff:/, '') ?? null;
    await tx.auditoria.create({
      data: {
        usuario_id: r.usuarioId,
        accion: r.accion.slice(0, 20),
        entidad: r.entidad.slice(0, 60),
        entidad_id: r.entidadId ?? null,
        valores_anteriores: aJsonb(r.anteriores),
        valores_nuevos: aJsonb(r.nuevos),
        ip: ip && /^[0-9a-f:.]+$/i.test(ip) ? ip : null,
        user_agent: r.peticion?.headers['user-agent'] ?? null,
      },
    });
  }
}

function aJsonb(valor: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (valor === undefined || valor === null) return Prisma.DbNull;
  return JSON.parse(
    JSON.stringify(valor, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    ),
  ) as Prisma.InputJsonValue;
}
