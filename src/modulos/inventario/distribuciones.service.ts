import { Injectable } from '@nestjs/common';
import { generarCodigo } from '../../comun/codigos';
import {
  conflicto,
  noEncontrado,
  noProcesable,
} from '../../comun/http/problema';
import { PrismaService } from '../../comun/prisma/prisma.service';
import { fechaBogota } from '../../comun/tiempo';
import type { Pagina } from '../../comun/validacion';
import { Prisma } from '../../generated/prisma/client';
import { AlmacenesService } from './almacenes.service';
import type {
  CrearDistribucionDto,
  ListarDistribucionesDto,
} from './inventario.dto';
import { LotesService, pesoProporcional, r2 } from './lotes.service';

interface LoteFefo {
  id: string;
  cantidad_disponible: number;
  cantidad_inicial: number;
  peso_inicial_kg: number;
  peso_disponible_kg: number;
}

/**
 * Salida FEFO (§10.2). Crear la distribución reserva el stock: descuenta los
 * lotes con su SALIDA en la misma transacción. Confirmar registra el despacho;
 * anular devuelve el stock con movimientos DEVOLUCION.
 */
@Injectable()
export class DistribucionesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lotes: LotesService,
    private readonly almacenes: AlmacenesService,
  ) {}

  async crear(usuarioId: string, dto: CrearDistribucionDto) {
    const bancoId = await this.almacenes.bancoId();
    const destino = await this.prisma.tipo_destino_distribucion.count({
      where: { id: dto.tipo_destino_id, activo: true },
    });
    if (!destino)
      throw noProcesable(
        'tipo-destino-invalido',
        'El tipo de destino no existe',
      );

    // Líneas repetidas (mismo tipo y unidad) se suman: un lote aparece una vez por distribución.
    const lineas = new Map<
      string,
      { tipo: number; unidad: number; cantidad: number }
    >();
    for (const l of dto.lineas) {
      const clave = `${l.tipo_alimento_id}:${l.unidad_medida_id}`;
      const previa = lineas.get(clave);
      lineas.set(clave, {
        tipo: l.tipo_alimento_id,
        unidad: l.unidad_medida_id,
        cantidad: r2((previa?.cantidad ?? 0) + l.cantidad),
      });
    }
    const hoy = fechaBogota();
    const filtroAlmacen = dto.almacen_id
      ? Prisma.sql`AND almacen_id = ${dto.almacen_id}::uuid`
      : Prisma.empty;

    const id = await this.prisma.transaccion(async (tx) => {
      const distribucion = await tx.distribucion.create({
        data: {
          codigo: generarCodigo('DIS'),
          banco_id: bancoId,
          tipo_destino_id: dto.tipo_destino_id,
          nombre_destino: dto.nombre_destino,
          documento_destino: dto.documento_destino ?? null,
          contacto: dto.contacto ?? null,
          telefono: dto.telefono ?? null,
          numero_beneficiarios: dto.numero_beneficiarios ?? null,
          observaciones: dto.observaciones ?? null,
          responsable_id: usuarioId,
        },
        select: { id: true },
      });

      const faltantes: {
        tipo_alimento_id: number;
        unidad_medida_id: number;
        faltante: number;
      }[] = [];
      for (const linea of lineas.values()) {
        // Vencidos fuera: FEFO nunca despacha un lote con la fecha cumplida.
        const candidatos = await tx.$queryRaw<LoteFefo[]>`
          SELECT id,
                 cantidad_disponible::float8 AS cantidad_disponible,
                 cantidad_inicial::float8 AS cantidad_inicial,
                 peso_inicial_kg::float8 AS peso_inicial_kg,
                 peso_disponible_kg::float8 AS peso_disponible_kg
            FROM lote_inventario
           WHERE banco_id = ${bancoId}::uuid
             AND tipo_alimento_id = ${linea.tipo}::smallint
             AND unidad_medida_id = ${linea.unidad}::smallint
             AND estado = 'DISPONIBLE' AND cantidad_disponible > 0
             AND (fecha_vencimiento IS NULL OR fecha_vencimiento >= ${hoy}::date)
             ${filtroAlmacen}
           ORDER BY fecha_vencimiento ASC NULLS LAST, fecha_ingreso ASC
           FOR UPDATE SKIP LOCKED`;

        let restante = linea.cantidad;
        for (const lote of candidatos) {
          if (restante <= 0) break;
          const tomar = r2(Math.min(restante, lote.cantidad_disponible));
          const saldo = r2(lote.cantidad_disponible - tomar);
          const peso = r2(
            lote.peso_disponible_kg -
              pesoProporcional(
                lote.peso_inicial_kg,
                lote.cantidad_inicial,
                saldo,
              ),
          );
          const detalle = await tx.distribucion_detalle.create({
            data: {
              distribucion_id: distribucion.id,
              lote_id: lote.id,
              cantidad: tomar,
              peso_kg: peso,
            },
            select: { id: true },
          });
          await this.lotes.mover(tx, {
            loteId: lote.id,
            tipo: 'SALIDA',
            delta: -tomar,
            usuarioId,
            detalleId: detalle.id,
          });
          restante = r2(restante - tomar);
        }
        if (restante > 0) {
          faltantes.push({
            tipo_alimento_id: linea.tipo,
            unidad_medida_id: linea.unidad,
            faltante: restante,
          });
        }
      }
      if (faltantes.length) {
        throw conflicto(
          'stock-insuficiente',
          'No hay existencias vigentes suficientes',
          undefined,
          { faltantes },
        );
      }
      return distribucion.id;
    });
    return this.detalle(id);
  }

  async confirmar(id: string) {
    const { count } = await this.prisma.distribucion.updateMany({
      where: { id, estado: 'BORRADOR' },
      data: { estado: 'CONFIRMADA', fecha_distribucion: new Date() },
    });
    if (!count) await this.exigirBorrador(id);
    return this.detalle(id);
  }

  async anular(id: string, usuarioId: string) {
    await this.prisma.transaccion(async (tx) => {
      const [actual] = await tx.$queryRaw<{ estado: string }[]>`
        SELECT estado::text AS estado FROM distribucion WHERE id = ${id}::uuid FOR UPDATE`;
      if (!actual) throw noEncontrado('Distribución');
      if (actual.estado !== 'BORRADOR') {
        throw conflicto(
          'distribucion-no-anulable',
          'Solo se anula una distribución en BORRADOR',
        );
      }
      const detalles = await tx.distribucion_detalle.findMany({
        where: { distribucion_id: id },
        select: { id: true, lote_id: true, cantidad: true },
      });
      for (const d of detalles) {
        await this.lotes.mover(tx, {
          loteId: d.lote_id,
          tipo: 'DEVOLUCION',
          delta: Number(d.cantidad),
          usuarioId,
          detalleId: d.id,
          motivo: 'Distribución anulada',
        });
      }
      await tx.distribucion.update({
        where: { id },
        data: { estado: 'ANULADA' },
      });
    });
    return this.detalle(id);
  }

  private async exigirBorrador(id: string): Promise<never> {
    const d = await this.prisma.distribucion.findUnique({
      where: { id },
      select: { estado: true },
    });
    if (!d) throw noEncontrado('Distribución');
    throw conflicto(
      'distribucion-no-borrador',
      'La distribución ya fue confirmada o anulada',
    );
  }

  async detalle(id: string) {
    const d = await this.prisma.distribucion.findUnique({
      where: { id },
      include: {
        tipo_destino_distribucion: { select: { codigo: true, nombre: true } },
        usuario: { select: { nombres: true, apellidos: true } },
        distribucion_detalle: {
          select: {
            id: true,
            cantidad: true,
            peso_kg: true,
            lote_inventario: {
              select: {
                id: true,
                codigo_lote: true,
                fecha_vencimiento: true,
                almacen_id: true,
                tipo_alimento: { select: { nombre: true } },
                unidad_medida: { select: { codigo: true } },
              },
            },
          },
        },
      },
    });
    if (!d) throw noEncontrado('Distribución');
    return d;
  }

  async listar(filtro: ListarDistribucionesDto): Promise<Pagina<unknown>> {
    const donde = filtro.estado ? { estado: filtro.estado } : {};
    const [datos, total] = await Promise.all([
      this.prisma.distribucion.findMany({
        where: donde,
        orderBy: { fecha_distribucion: 'desc' },
        take: filtro.limite,
        skip: filtro.desplazamiento,
        select: {
          id: true,
          codigo: true,
          estado: true,
          nombre_destino: true,
          numero_beneficiarios: true,
          fecha_distribucion: true,
          tipo_destino_distribucion: { select: { nombre: true } },
          _count: { select: { distribucion_detalle: true } },
        },
      }),
      this.prisma.distribucion.count({ where: donde }),
    ]);
    return {
      datos,
      total,
      limite: filtro.limite,
      desplazamiento: filtro.desplazamiento,
    };
  }
}
