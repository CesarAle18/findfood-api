import { Injectable } from '@nestjs/common';
import type { UsuarioAutenticado } from '../../comun/auth/tipos';
import { violaUnicidad } from '../../comun/http/errores-pg';
import {
  conflicto,
  noEncontrado,
  noProcesable,
} from '../../comun/http/problema';
import { validarMotivo } from '../../comun/motivos';
import { PrismaService } from '../../comun/prisma/prisma.service';
import type { Pagina } from '../../comun/validacion';
import { DonacionesService } from '../donaciones/donaciones.service';
import { NotificacionesService } from '../notificaciones/notificaciones.service';
import type { CrearRecepcionDto, ListarRecepcionesDto } from './inventario.dto';
import { LotesService, r2 } from './lotes.service';

/**
 * Recepción en la sede (§10.1), en una sola transacción: recepción, un lote por
 * producto aceptado con su ENTRADA, cambio de estado de la donación, contadores
 * de impacto, historial y aviso al donante.
 */
@Injectable()
export class RecepcionesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly donaciones: DonacionesService,
    private readonly lotes: LotesService,
    private readonly notificaciones: NotificacionesService,
  ) {}

  async crear(usuario: UsuarioAutenticado, dto: CrearRecepcionDto) {
    if (dto.estado !== 'ACEPTADA' && !dto.motivo_id) {
      throw noProcesable(
        'motivo-requerido',
        'Indica el motivo del rechazo total o parcial',
      );
    }
    if (dto.estado === 'RECHAZADA' && dto.items?.length) {
      throw noProcesable(
        'items-en-rechazo',
        'Una recepción rechazada no acepta productos',
      );
    }
    if (dto.estado === 'ACEPTADA_PARCIAL' && !dto.items?.length) {
      throw noProcesable('items-requeridos', 'Indica los productos aceptados');
    }

    try {
      const recepcionId = await this.prisma.transaccion(async (tx) => {
        const motivo = dto.motivo_id
          ? await validarMotivo(
              tx,
              dto.motivo_id,
              'RECHAZO_RECEPCION',
              dto.observaciones,
            )
          : null;
        const bloqueada = await this.donaciones.bloquear(tx, dto.donacion_id);
        if (!bloqueada) throw noEncontrado('Donación');
        if (bloqueada.estado !== 'ENTREGADA') {
          throw conflicto(
            'donacion-no-entregada',
            'Solo se recibe una donación ENTREGADA en la sede',
            `Estado actual: ${bloqueada.estado}`,
          );
        }
        const donacion = await tx.donacion.findUniqueOrThrow({
          where: { id: dto.donacion_id },
          select: {
            almacen_destino_id: true,
            peso_estimado_kg: true,
            peso_recogido_kg: true,
            almacen: { select: { banco_id: true } },
            donante_id: true,
            donacion_item: {
              select: {
                id: true,
                tipo_alimento_id: true,
                unidad_medida_id: true,
                cantidad: true,
                peso_estimado_kg: true,
                peso_real_kg: true,
                fecha_vencimiento: true,
              },
            },
          },
        });
        if (!donacion.almacen_destino_id || !donacion.almacen) {
          throw conflicto(
            'donacion-sin-sede',
            'La donación no tiene sede de destino',
          );
        }

        // Productos aceptados.
        const porItem = new Map(dto.items?.map((i) => [i.donacion_item_id, i]));
        for (const id of porItem.keys()) {
          if (!donacion.donacion_item.some((i) => i.id === id)) {
            throw noProcesable(
              'item-invalido',
              'Un producto no pertenece a la donación',
            );
          }
        }
        const aceptados =
          dto.estado === 'RECHAZADA'
            ? []
            : donacion.donacion_item
                .filter((i) => dto.estado === 'ACEPTADA' || porItem.has(i.id))
                .map((i) => {
                  const ajuste = porItem.get(i.id);
                  const cantidad =
                    ajuste?.cantidad_aceptada ?? Number(i.cantidad);
                  if (cantidad > Number(i.cantidad)) {
                    throw noProcesable(
                      'cantidad-invalida',
                      'No se acepta más cantidad de la declarada en el producto',
                    );
                  }
                  return {
                    item: i,
                    cantidad: r2(cantidad),
                    peso: r2(
                      ajuste?.peso_aceptado_kg ??
                        Number(i.peso_real_kg ?? i.peso_estimado_kg),
                    ),
                    fecha: i.fecha_vencimiento,
                  };
                })
                .filter((a) => a.cantidad > 0);
        if (dto.estado !== 'RECHAZADA' && !aceptados.length) {
          throw noProcesable(
            'sin-productos-aceptados',
            'Si no se acepta ningún producto, la recepción es RECHAZADA',
          );
        }

        const pesoRecibido = r2(aceptados.reduce((s, a) => s + a.peso, 0));
        const pesoReferencia = Number(
          donacion.peso_recogido_kg ?? donacion.peso_estimado_kg,
        );
        const pesoRechazado = r2(Math.max(0, pesoReferencia - pesoRecibido));

        const parada = await tx.parada_ruta.findFirst({
          where: {
            tipo: 'ENTREGA',
            estado: 'COMPLETADA',
            ruta: { asignacion: { some: { donacion_id: dto.donacion_id } } },
          },
          orderBy: { confirmada_at: 'desc' },
          select: { id: true },
        });

        const recepcion = await tx.recepcion_donacion.create({
          data: {
            donacion_id: dto.donacion_id,
            almacen_id: donacion.almacen_destino_id,
            parada_id: parada?.id ?? null,
            recibida_por: usuario.id,
            estado: dto.estado,
            peso_recibido_kg: pesoRecibido,
            peso_rechazado_kg: pesoRechazado,
            motivo_id: motivo?.id ?? null,
            observaciones: dto.observaciones ?? null,
          },
          select: { id: true },
        });

        for (const a of aceptados) {
          await this.lotes.crear(tx, {
            bancoId: donacion.almacen.banco_id,
            almacenId: donacion.almacen_destino_id,
            recepcionId: recepcion.id,
            donacionItemId: a.item.id,
            tipoAlimentoId: a.item.tipo_alimento_id,
            unidadMedidaId: a.item.unidad_medida_id,
            cantidad: a.cantidad,
            pesoKg: a.peso,
            fechaVencimiento: a.fecha,
            usuarioId: usuario.id,
          });
        }

        const rechazada = dto.estado === 'RECHAZADA';
        await this.donaciones.transicion(tx, {
          donacionId: dto.donacion_id,
          desde: ['ENTREGADA'],
          hacia: rechazada ? 'RECHAZADA' : 'RECIBIDA',
          usuarioId: usuario.id,
          motivo: motivo?.nombre,
          datos: { recibida_at: new Date(), peso_recibido_kg: pesoRecibido },
          metadata: {
            recepcion_id: recepcion.id,
            estado_recepcion: dto.estado,
          },
        });

        // Contadores de impacto (§12.3).
        if (pesoRecibido > 0) {
          await tx.donante.update({
            where: { id: donacion.donante_id },
            data: {
              total_donaciones: { increment: 1 },
              total_kg_donados: { increment: pesoRecibido },
            },
          });
        }
        const asignacion = await tx.asignacion.findFirst({
          where: {
            donacion_id: dto.donacion_id,
            estado: 'COMPLETADA',
            voluntario_id: { not: null },
          },
          select: { voluntario_id: true },
        });
        if (asignacion?.voluntario_id) {
          await tx.voluntario.update({
            where: { id: asignacion.voluntario_id },
            data: {
              total_entregas: { increment: 1 },
              total_kg_transportados: { increment: pesoReferencia },
            },
          });
        }

        await this.notificaciones.encolar(tx, {
          usuarioId: bloqueada.donante_usuario_id,
          codigo: rechazada ? 'DONACION_RECHAZADA' : 'DONACION_RECIBIDA',
          donacionId: dto.donacion_id,
          variables: { kg: pesoRecibido, motivo: motivo?.nombre ?? '' },
        });
        return recepcion.id;
      });
      return this.detalle(recepcionId);
    } catch (err) {
      if (violaUnicidad(err, 'uq_recepcion_donacion')) {
        throw conflicto(
          'ya-recibida',
          'La donación ya tiene una recepción registrada',
        );
      }
      throw err;
    }
  }

  async detalle(id: string) {
    const recepcion = await this.prisma.recepcion_donacion.findUnique({
      where: { id },
      select: {
        id: true,
        estado: true,
        peso_recibido_kg: true,
        peso_rechazado_kg: true,
        observaciones: true,
        fecha_recepcion: true,
        donacion: { select: { id: true, codigo: true, estado: true } },
        almacen: { select: { id: true, nombre: true } },
        motivo: { select: { codigo: true, nombre: true } },
        usuario: { select: { nombres: true, apellidos: true } },
        lote_inventario: {
          select: {
            id: true,
            codigo_lote: true,
            cantidad_inicial: true,
            peso_inicial_kg: true,
            fecha_vencimiento: true,
            tipo_alimento: { select: { nombre: true } },
          },
        },
      },
    });
    if (!recepcion) throw noEncontrado('Recepción');
    const { usuario, lote_inventario, ...resto } = recepcion;
    return { ...resto, recibida_por: usuario, lotes: lote_inventario };
  }

  async listar(filtro: ListarRecepcionesDto): Promise<Pagina<unknown>> {
    const donde = filtro.almacen_id ? { almacen_id: filtro.almacen_id } : {};
    const [datos, total] = await Promise.all([
      this.prisma.recepcion_donacion.findMany({
        where: donde,
        orderBy: { fecha_recepcion: 'desc' },
        take: filtro.limite,
        skip: filtro.desplazamiento,
        select: {
          id: true,
          estado: true,
          peso_recibido_kg: true,
          peso_rechazado_kg: true,
          fecha_recepcion: true,
          donacion: { select: { id: true, codigo: true } },
          almacen: { select: { id: true, nombre: true } },
        },
      }),
      this.prisma.recepcion_donacion.count({ where: donde }),
    ]);
    return {
      datos,
      total,
      limite: filtro.limite,
      desplazamiento: filtro.desplazamiento,
    };
  }
}
