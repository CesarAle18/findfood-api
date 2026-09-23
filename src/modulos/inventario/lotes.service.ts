import { Injectable } from '@nestjs/common';
import { generarCodigo } from '../../comun/codigos';
import {
  conflicto,
  noEncontrado,
  noProcesable,
} from '../../comun/http/problema';
import { PrismaService, type Tx } from '../../comun/prisma/prisma.service';
import { fechaBogota } from '../../comun/tiempo';
import { TrazabilidadService } from '../../comun/trazabilidad/trazabilidad.service';
import type { Pagina } from '../../comun/validacion';
import type {
  estado_lote,
  tipo_movimiento,
} from '../../generated/prisma/enums';
import { NotificacionesService } from '../notificaciones/notificaciones.service';
import { ParametrosService } from '../parametros/parametros.service';
import type { AjusteLoteDto, ListarLotesDto } from './inventario.dto';

export const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Peso que corresponde a un saldo, proporcional al lote original (evita la deriva por redondeo). */
export function pesoProporcional(
  pesoInicial: number,
  cantidadInicial: number,
  saldo: number,
): number {
  return r2((pesoInicial * saldo) / cantidadInicial);
}

interface LoteBloqueado {
  id: string;
  estado: estado_lote;
  cantidad_inicial: number;
  cantidad_disponible: number;
  peso_inicial_kg: number;
  peso_disponible_kg: number;
}

export interface Movimiento {
  loteId: string;
  tipo: tipo_movimiento;
  /** Con signo: positivo entra, negativo sale. */
  delta: number;
  usuarioId: string;
  motivo?: string;
  recepcionId?: string;
  detalleId?: string;
}

export interface NuevoLote {
  bancoId: string;
  almacenId: string;
  recepcionId: string;
  donacionItemId: string;
  tipoAlimentoId: number;
  unidadMedidaId: number;
  cantidad: number;
  pesoKg: number;
  fechaVencimiento: Date | null;
  usuarioId: string;
}

/**
 * Lotes y su libro mayor (§10): cantidad_disponible se reconstruye exactamente
 * como la suma de movimiento_inventario.cantidad, porque todo cambio de saldo
 * se escribe junto con el movimiento que lo explica.
 */
@Injectable()
export class LotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trazabilidad: TrazabilidadService,
    private readonly parametros: ParametrosService,
    private readonly notificaciones: NotificacionesService,
  ) {}

  async bloquear(tx: Tx, id: string): Promise<LoteBloqueado> {
    const [lote] = await tx.$queryRaw<LoteBloqueado[]>`
      SELECT id, estado::text AS estado,
             cantidad_inicial::float8 AS cantidad_inicial,
             cantidad_disponible::float8 AS cantidad_disponible,
             peso_inicial_kg::float8 AS peso_inicial_kg,
             peso_disponible_kg::float8 AS peso_disponible_kg
        FROM lote_inventario WHERE id = ${id}::uuid FOR UPDATE`;
    if (!lote) throw noEncontrado('Lote');
    return lote;
  }

  async crear(tx: Tx, n: NuevoLote): Promise<string> {
    const lote = await tx.lote_inventario.create({
      data: {
        codigo_lote: generarCodigo('L'),
        banco_id: n.bancoId,
        almacen_id: n.almacenId,
        recepcion_id: n.recepcionId,
        donacion_item_id: n.donacionItemId,
        tipo_alimento_id: n.tipoAlimentoId,
        unidad_medida_id: n.unidadMedidaId,
        cantidad_inicial: n.cantidad,
        cantidad_disponible: n.cantidad,
        peso_inicial_kg: n.pesoKg,
        peso_disponible_kg: n.pesoKg,
        fecha_vencimiento: n.fechaVencimiento,
        created_by: n.usuarioId,
      },
      select: { id: true },
    });
    await tx.movimiento_inventario.create({
      data: {
        lote_id: lote.id,
        tipo: 'ENTRADA',
        cantidad: n.cantidad,
        peso_kg: n.pesoKg,
        saldo_cantidad: n.cantidad,
        recepcion_id: n.recepcionId,
        usuario_id: n.usuarioId,
      },
    });
    await this.trazabilidad.registrar(tx, {
      ambito: 'LOTE',
      entidad: { loteId: lote.id },
      nuevo: 'DISPONIBLE',
      usuarioId: n.usuarioId,
      metadata: {
        recepcion_id: n.recepcionId,
        donacion_item_id: n.donacionItemId,
      },
    });
    return lote.id;
  }

  /** Aplica un movimiento y actualiza saldo, peso y estado en la misma transacción. */
  async mover(
    tx: Tx,
    m: Movimiento,
  ): Promise<{ saldo: number; pesoMovido: number }> {
    const lote = await this.bloquear(tx, m.loteId);
    if (
      (lote.estado === 'VENCIDO' || lote.estado === 'DESCARTADO') &&
      m.tipo !== 'DEVOLUCION'
    ) {
      throw conflicto('lote-cerrado', `El lote está ${lote.estado}`);
    }
    const saldo = r2(lote.cantidad_disponible + m.delta);
    if (saldo < 0 || saldo > lote.cantidad_inicial) {
      throw noProcesable(
        'saldo-invalido',
        `El movimiento dejaría el lote en ${saldo} (disponible ${lote.cantidad_disponible}, inicial ${lote.cantidad_inicial})`,
      );
    }
    const peso = pesoProporcional(
      lote.peso_inicial_kg,
      lote.cantidad_inicial,
      saldo,
    );
    const pesoMovido = r2(peso - lote.peso_disponible_kg);

    let estado: estado_lote = lote.estado;
    if (saldo === 0) {
      estado =
        m.tipo === 'VENCIMIENTO'
          ? 'VENCIDO'
          : m.tipo === 'MERMA'
            ? 'DESCARTADO'
            : 'AGOTADO';
    } else if (lote.estado === 'AGOTADO') {
      estado = 'DISPONIBLE';
    }

    await tx.lote_inventario.update({
      where: { id: m.loteId },
      data: { cantidad_disponible: saldo, peso_disponible_kg: peso, estado },
    });
    await tx.movimiento_inventario.create({
      data: {
        lote_id: m.loteId,
        tipo: m.tipo,
        cantidad: m.delta,
        peso_kg: pesoMovido,
        saldo_cantidad: saldo,
        distribucion_detalle_id: m.detalleId ?? null,
        recepcion_id: m.recepcionId ?? null,
        motivo: m.motivo ?? null,
        usuario_id: m.usuarioId,
      },
    });
    if (estado !== lote.estado) {
      await this.trazabilidad.registrar(tx, {
        ambito: 'LOTE',
        entidad: { loteId: m.loteId },
        anterior: lote.estado,
        nuevo: estado,
        usuarioId: m.usuarioId,
        motivo: m.motivo ?? m.tipo,
      });
    }
    return { saldo, pesoMovido };
  }

  /** Vista FEFO (vw_inventario_fefo): primero en vencer, primero en salir. */
  async listar(filtro: ListarLotesDto): Promise<Pagina<unknown>> {
    const almacen = filtro.almacen_id ?? null;
    const tipo = filtro.tipo_alimento_id ?? null;
    const [datos, [{ total }]] = await Promise.all([
      this.prisma.$queryRaw<unknown[]>`
        SELECT v.*, a.nombre AS almacen, um.codigo AS unidad
          FROM vw_inventario_fefo v
          JOIN almacen a ON a.id = v.almacen_id
          JOIN lote_inventario l ON l.id = v.lote_id
          JOIN unidad_medida um ON um.id = l.unidad_medida_id
         WHERE (${almacen}::uuid IS NULL OR v.almacen_id = ${almacen}::uuid)
           AND (${tipo}::int IS NULL OR v.tipo_alimento_id = ${tipo}::int)
         ORDER BY v.tipo_alimento_id, v.fecha_vencimiento ASC NULLS LAST, l.fecha_ingreso
         LIMIT ${filtro.limite} OFFSET ${filtro.desplazamiento}`,
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM vw_inventario_fefo v
         WHERE (${almacen}::uuid IS NULL OR v.almacen_id = ${almacen}::uuid)
           AND (${tipo}::int IS NULL OR v.tipo_alimento_id = ${tipo}::int)`,
    ]);
    return {
      datos,
      total,
      limite: filtro.limite,
      desplazamiento: filtro.desplazamiento,
    };
  }

  /** Lote con su trazabilidad: producto → donación → donante, y su libro mayor. */
  async detalle(id: string) {
    const lote = await this.prisma.lote_inventario.findUnique({
      where: { id },
      include: {
        tipo_alimento: { select: { id: true, codigo: true, nombre: true } },
        unidad_medida: { select: { codigo: true } },
        almacen: { select: { id: true, nombre: true } },
        donacion_item: {
          select: {
            id: true,
            descripcion: true,
            donacion: { select: { id: true, codigo: true, donante_id: true } },
          },
        },
        movimiento_inventario: {
          orderBy: { created_at: 'asc' },
          select: {
            id: true,
            tipo: true,
            cantidad: true,
            peso_kg: true,
            saldo_cantidad: true,
            motivo: true,
            distribucion_detalle_id: true,
            recepcion_id: true,
            created_at: true,
          },
        },
      },
    });
    if (!lote) throw noEncontrado('Lote');
    return lote;
  }

  async ajustar(id: string, dto: AjusteLoteDto, usuarioId: string) {
    const delta =
      dto.tipo === 'AJUSTE' ? dto.cantidad : -Math.abs(dto.cantidad);
    await this.prisma.transaccion((tx) =>
      this.mover(tx, {
        loteId: id,
        tipo: dto.tipo,
        delta,
        usuarioId,
        motivo: dto.motivo,
      }),
    );
    return this.detalle(id);
  }

  // --- Alertas ----------------------------------------------------------------

  /**
   * Tarea alertas_vencimiento (§7): una alerta abierta por lote y tipo
   * (uq_alerta_abierta impide duplicados) y un aviso en la bandeja de los asesores.
   */
  async generarAlertasVencimiento(): Promise<number> {
    const dias = await this.parametros.entero('DIAS_ALERTA_VENCIMIENTO');
    const hoy = fechaBogota();
    return this.prisma.transaccion(async (tx) => {
      const nuevas = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO alerta_inventario (banco_id, lote_id, tipo, nivel, dias_para_vencer, mensaje)
        SELECT l.banco_id, l.id,
               CASE WHEN l.fecha_vencimiento < ${hoy}::date THEN 'VENCIDO' ELSE 'PROXIMO_VENCIMIENTO' END,
               (CASE WHEN l.fecha_vencimiento <= ${hoy}::date + 1 THEN 'ALTA' ELSE 'MEDIA' END)::severidad,
               (l.fecha_vencimiento - ${hoy}::date)::smallint,
               format('Lote %s (%s, %s %s) en %s vence el %s',
                      l.codigo_lote, ta.nombre, l.cantidad_disponible, um.codigo, a.nombre,
                      to_char(l.fecha_vencimiento, 'YYYY-MM-DD'))
          FROM lote_inventario l
          JOIN tipo_alimento ta ON ta.id = l.tipo_alimento_id
          JOIN unidad_medida um ON um.id = l.unidad_medida_id
          JOIN almacen a ON a.id = l.almacen_id
         WHERE l.estado IN ('DISPONIBLE','RESERVADO')
           AND l.cantidad_disponible > 0
           AND l.fecha_vencimiento IS NOT NULL
           AND l.fecha_vencimiento <= ${hoy}::date + ${dias}::int
        ON CONFLICT (lote_id, tipo) WHERE atendida_at IS NULL AND lote_id IS NOT NULL DO NOTHING
        RETURNING id`;
      if (nuevas.length) {
        const asesores = await tx.usuario.findMany({
          where: {
            estado: 'ACTIVO',
            deleted_at: null,
            usuario_rol_usuario_rol_usuario_idTousuario: {
              some: { activo: true, rol: { codigo: 'ASESOR_BANCO' } },
            },
          },
          select: { id: true },
        });
        await this.notificaciones.encolarVarias(
          tx,
          asesores.map((a) => ({
            usuarioId: a.id,
            codigo: 'ALERTA_VENCIMIENTO' as const,
            variables: { cantidad: nuevas.length },
          })),
        );
      }
      return nuevas.length;
    });
  }

  listarAlertas(soloAbiertas: boolean) {
    return this.prisma.alerta_inventario.findMany({
      where: soloAbiertas ? { atendida_at: null } : {},
      orderBy: [
        { atendida_at: 'asc' },
        { nivel: 'desc' },
        { generada_at: 'desc' },
      ],
      take: 200,
      select: {
        id: true,
        tipo: true,
        nivel: true,
        dias_para_vencer: true,
        mensaje: true,
        generada_at: true,
        atendida_at: true,
        accion_tomada: true,
        lote_inventario: {
          select: { id: true, codigo_lote: true, almacen_id: true },
        },
      },
    });
  }

  async atenderAlerta(id: string, accion: string, usuarioId: string) {
    const { count } = await this.prisma.alerta_inventario.updateMany({
      where: { id, atendida_at: null },
      data: {
        atendida_at: new Date(),
        atendida_por: usuarioId,
        accion_tomada: accion,
      },
    });
    if (!count) {
      const existe = await this.prisma.alerta_inventario.count({
        where: { id },
      });
      if (!existe) throw noEncontrado('Alerta');
      throw conflicto('alerta-atendida', 'La alerta ya fue atendida');
    }
    return this.prisma.alerta_inventario.findUnique({ where: { id } });
  }
}
