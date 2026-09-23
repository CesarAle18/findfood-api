import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { sqlPunto } from '../../comun/geo';
import { violaUnicidad } from '../../comun/http/errores-pg';
import {
  conflicto,
  noEncontrado,
  noProcesable,
} from '../../comun/http/problema';
import { PrismaService } from '../../comun/prisma/prisma.service';
import { TrazabilidadService } from '../../comun/trazabilidad/trazabilidad.service';
import type {
  ActualizarTipoAlimentoDto,
  BancoDto,
  TipoAlimentoDto,
} from './admin.dto';

@Injectable()
export class CatalogosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trazabilidad: TrazabilidadService,
  ) {}

  /** Catálogos activos que necesitan los formularios de la app y del panel. */
  async todos() {
    const [
      categorias,
      tiposAlimento,
      unidades,
      tiposVehiculo,
      motivos,
      tiposIncidencia,
      tiposDestino,
    ] = await Promise.all([
      this.prisma.categoria_alimento.findMany({
        where: { activo: true },
        orderBy: { nombre: 'asc' },
        select: {
          id: true,
          codigo: true,
          nombre: true,
          requiere_refrigeracion: true,
          vida_util_dias_ref: true,
        },
      }),
      this.prisma.tipo_alimento.findMany({
        where: { activo: true },
        orderBy: { nombre: 'asc' },
        select: {
          id: true,
          codigo: true,
          nombre: true,
          categoria_alimento_id: true,
          unidad_medida_id: true,
          requiere_refrigeracion: true,
          tipo_almacenamiento: true,
          perecedero: true,
          vida_util_dias: true,
        },
      }),
      this.prisma.unidad_medida.findMany({
        where: { activo: true },
        orderBy: { id: 'asc' },
        select: { id: true, codigo: true, nombre: true, factor_a_kg: true },
      }),
      this.prisma.tipo_vehiculo.findMany({
        where: { activo: true },
        orderBy: { capacidad_referencia_kg: 'asc' },
        select: {
          id: true,
          codigo: true,
          nombre: true,
          capacidad_referencia_kg: true,
          permite_refrigeracion: true,
        },
      }),
      this.prisma.motivo.findMany({
        where: { activo: true },
        orderBy: [{ ambito: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          ambito: true,
          codigo: true,
          nombre: true,
          requiere_comentario: true,
        },
      }),
      this.prisma.tipo_incidencia.findMany({
        where: { activo: true },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          codigo: true,
          nombre: true,
          severidad_default: true,
          bloquea_donacion: true,
        },
      }),
      this.prisma.tipo_destino_distribucion.findMany({
        where: { activo: true },
        orderBy: { id: 'asc' },
        select: { id: true, codigo: true, nombre: true },
      }),
    ]);
    return {
      categorias_alimento: categorias,
      tipos_alimento: tiposAlimento,
      unidades_medida: unidades,
      tipos_vehiculo: tiposVehiculo,
      motivos,
      tipos_incidencia: tiposIncidencia,
      tipos_destino_distribucion: tiposDestino,
    };
  }

  async crearTipoAlimento(
    dto: TipoAlimentoDto,
    usuarioId: string,
    peticion?: Request,
  ) {
    const [categoria, unidad] = await Promise.all([
      this.prisma.categoria_alimento.count({
        where: { id: dto.categoria_alimento_id },
      }),
      this.prisma.unidad_medida.count({ where: { id: dto.unidad_medida_id } }),
    ]);
    if (!categoria || !unidad) {
      throw noProcesable(
        'referencia-invalida',
        'La categoría o la unidad no existen',
      );
    }
    try {
      return await this.prisma.transaccion(async (tx) => {
        const tipo = await tx.tipo_alimento.create({ data: dto });
        await this.trazabilidad.auditar(tx, {
          usuarioId,
          accion: 'CREAR',
          entidad: 'tipo_alimento',
          entidadId: String(tipo.id),
          nuevos: dto,
          peticion,
        });
        return tipo;
      });
    } catch (err) {
      if (violaUnicidad(err))
        throw conflicto(
          'tipo-alimento-duplicado',
          'Ya existe un tipo con ese código o nombre',
        );
      throw err;
    }
  }

  async actualizarTipoAlimento(
    id: number,
    dto: ActualizarTipoAlimentoDto,
    usuarioId: string,
    peticion?: Request,
  ) {
    const actual = await this.prisma.tipo_alimento.findUnique({
      where: { id },
    });
    if (!actual) throw noEncontrado('Tipo de alimento');
    try {
      return await this.prisma.transaccion(async (tx) => {
        const tipo = await tx.tipo_alimento.update({
          where: { id },
          data: dto,
        });
        await this.trazabilidad.auditar(tx, {
          usuarioId,
          accion: 'ACTUALIZAR',
          entidad: 'tipo_alimento',
          entidadId: String(id),
          anteriores: actual,
          nuevos: dto,
          peticion,
        });
        return tipo;
      });
    } catch (err) {
      if (violaUnicidad(err))
        throw conflicto(
          'tipo-alimento-duplicado',
          'Ya existe un tipo con ese nombre',
        );
      throw err;
    }
  }

  async banco() {
    const [banco] = await this.prisma.$queryRaw<unknown[]>`
      SELECT id, nombre, documento_fiscal, direccion, ciudad, telefono, email::text AS email,
             capacidad_total_kg, radio_operacion_km, tiene_flota_propia, horario_recepcion, activo,
             ST_Y(ubicacion::geometry) AS lat, ST_X(ubicacion::geometry) AS lng
        FROM banco_alimentos WHERE deleted_at IS NULL LIMIT 1`;
    if (!banco) throw noEncontrado('Banco de alimentos');
    return banco;
  }

  /** Crea o actualiza el único banco de alimentos (uq_banco_unico). */
  async guardarBanco(dto: BancoDto, usuarioId: string, peticion?: Request) {
    await this.prisma.transaccion(async (tx) => {
      const actual = await tx.banco_alimentos.findFirst({
        where: { deleted_at: null },
        select: { id: true },
      });
      const horario = dto.horario_recepcion
        ? JSON.stringify(dto.horario_recepcion)
        : null;
      if (actual) {
        await tx.$executeRaw`
          UPDATE banco_alimentos SET
            nombre = ${dto.nombre}, documento_fiscal = ${dto.documento_fiscal ?? null},
            direccion = ${dto.direccion}, ciudad = ${dto.ciudad}, ubicacion = ${sqlPunto(dto.ubicacion)},
            telefono = ${dto.telefono ?? null}, email = ${dto.email ?? null}::citext,
            capacidad_total_kg = coalesce(${dto.capacidad_total_kg ?? null}::numeric, capacidad_total_kg),
            radio_operacion_km = ${dto.radio_operacion_km ?? null}::numeric,
            tiene_flota_propia = coalesce(${dto.tiene_flota_propia ?? null}::boolean, tiene_flota_propia),
            horario_recepcion = ${horario}::jsonb
          WHERE id = ${actual.id}::uuid`;
      } else {
        await tx.$executeRaw`
          INSERT INTO banco_alimentos
            (nombre, documento_fiscal, direccion, ciudad, ubicacion, telefono, email,
             capacidad_total_kg, radio_operacion_km, tiene_flota_propia, horario_recepcion)
          VALUES (
            ${dto.nombre}, ${dto.documento_fiscal ?? null}, ${dto.direccion}, ${dto.ciudad},
            ${sqlPunto(dto.ubicacion)}, ${dto.telefono ?? null}, ${dto.email ?? null}::citext,
            ${dto.capacidad_total_kg ?? 0}::numeric, ${dto.radio_operacion_km ?? null}::numeric,
            ${dto.tiene_flota_propia ?? false}, ${horario}::jsonb)`;
      }
      await this.trazabilidad.auditar(tx, {
        usuarioId,
        accion: actual ? 'ACTUALIZAR' : 'CREAR',
        entidad: 'banco_alimentos',
        entidadId: actual?.id,
        nuevos: dto,
        peticion,
      });
    });
    return this.banco();
  }
}
