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
import type { Prisma } from '../../generated/prisma/client';
import type { ActualizarAlmacenDto, CrearAlmacenDto } from './inventario.dto';

/** Sedes del banco (§6.6). La capacidad es informativa: la gestiona el personal. */
@Injectable()
export class AlmacenesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trazabilidad: TrazabilidadService,
  ) {}

  /** El sistema opera un único banco (uq_banco_unico). */
  async bancoId(): Promise<string> {
    const banco = await this.prisma.banco_alimentos.findFirst({
      where: { deleted_at: null },
      select: { id: true },
    });
    if (!banco) {
      throw noProcesable(
        'sin-banco',
        'Configura primero el banco de alimentos (PUT /v1/admin/banco)',
      );
    }
    return banco.id;
  }

  listar() {
    return this.prisma.$queryRaw`
      SELECT a.id, a.nombre, a.direccion, a.ciudad, a.telefono, a.tipo::text AS tipo,
             a.capacidad_kg, a.temperatura_min, a.temperatura_max, a.activo,
             a.horario_disponibilidad,
             ST_Y(a.ubicacion::geometry) AS lat, ST_X(a.ubicacion::geometry) AS lng,
             coalesce(sum(l.peso_disponible_kg) FILTER (WHERE l.estado IN ('DISPONIBLE','RESERVADO')), 0)
               AS kg_en_inventario
        FROM almacen a
        LEFT JOIN lote_inventario l ON l.almacen_id = a.id
       GROUP BY a.id
       ORDER BY a.nombre`;
  }

  async crear(dto: CrearAlmacenDto, usuarioId: string, peticion?: Request) {
    this.validarTemperaturas(dto.temperatura_min, dto.temperatura_max);
    const bancoId = await this.bancoId();
    try {
      const id = await this.prisma.transaccion(async (tx) => {
        const [{ id }] = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO almacen
            (banco_id, nombre, direccion, ciudad, ubicacion, telefono, horario_disponibilidad,
             tipo, capacidad_kg, temperatura_min, temperatura_max)
          VALUES (
            ${bancoId}::uuid, ${dto.nombre}, ${dto.direccion}, ${dto.ciudad},
            ${sqlPunto(dto.ubicacion)}, ${dto.telefono ?? null},
            ${JSON.stringify(dto.horario_disponibilidad)}::jsonb,
            ${dto.tipo}::tipo_almacenamiento, ${dto.capacidad_kg}::numeric,
            ${dto.temperatura_min ?? null}::numeric, ${dto.temperatura_max ?? null}::numeric)
          RETURNING id`;
        await this.trazabilidad.auditar(tx, {
          usuarioId,
          accion: 'CREAR',
          entidad: 'almacen',
          entidadId: id,
          nuevos: dto,
          peticion,
        });
        return id;
      });
      return this.detalle(id);
    } catch (err) {
      if (violaUnicidad(err)) {
        throw conflicto(
          'almacen-duplicado',
          'Ya existe una sede con ese nombre',
        );
      }
      throw err;
    }
  }

  async actualizar(
    id: string,
    dto: ActualizarAlmacenDto,
    usuarioId: string,
    peticion?: Request,
  ) {
    const actual = await this.prisma.almacen.findUnique({ where: { id } });
    if (!actual) throw noEncontrado('Almacén');
    this.validarTemperaturas(
      dto.temperatura_min ??
        (actual.temperatura_min === null
          ? undefined
          : Number(actual.temperatura_min)),
      dto.temperatura_max ??
        (actual.temperatura_max === null
          ? undefined
          : Number(actual.temperatura_max)),
    );
    const datos: Prisma.almacenUpdateInput = {
      ...(dto.activo !== undefined ? { activo: dto.activo } : {}),
      ...(dto.nombre !== undefined ? { nombre: dto.nombre } : {}),
      ...(dto.telefono !== undefined ? { telefono: dto.telefono } : {}),
      ...(dto.horario_disponibilidad !== undefined
        ? {
            horario_disponibilidad:
              dto.horario_disponibilidad as Prisma.InputJsonValue,
          }
        : {}),
      ...(dto.capacidad_kg !== undefined
        ? { capacidad_kg: dto.capacidad_kg }
        : {}),
      ...(dto.temperatura_min !== undefined
        ? { temperatura_min: dto.temperatura_min }
        : {}),
      ...(dto.temperatura_max !== undefined
        ? { temperatura_max: dto.temperatura_max }
        : {}),
    };
    await this.prisma.transaccion(async (tx) => {
      await tx.almacen.update({ where: { id }, data: datos });
      await this.trazabilidad.auditar(tx, {
        usuarioId,
        accion: 'ACTUALIZAR',
        entidad: 'almacen',
        entidadId: id,
        anteriores: {
          activo: actual.activo,
          nombre: actual.nombre,
          capacidad_kg: actual.capacidad_kg,
        },
        nuevos: dto,
        peticion,
      });
    });
    return this.detalle(id);
  }

  private validarTemperaturas(min?: number, max?: number) {
    if (min !== undefined && max !== undefined && max < min) {
      throw noProcesable(
        'temperaturas-invalidas',
        'temperatura_max debe ser mayor o igual a temperatura_min',
      );
    }
  }

  private async detalle(id: string) {
    const [a] = await this.prisma.$queryRaw<unknown[]>`
      SELECT id, nombre, direccion, ciudad, telefono, tipo::text AS tipo, capacidad_kg,
             temperatura_min, temperatura_max, activo, horario_disponibilidad,
             ST_Y(ubicacion::geometry) AS lat, ST_X(ubicacion::geometry) AS lng
        FROM almacen WHERE id = ${id}::uuid`;
    return a;
  }
}
