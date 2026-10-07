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
import {
  type ActualizarTipoAlimentoDto,
  type BancoDto,
  type Catalogo,
  CATALOGOS,
  type FiltroCatalogosDto,
  type TipoAlimentoDto,
} from './admin.dto';

@Injectable()
export class CatalogosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trazabilidad: TrazabilidadService,
  ) {}

  /**
   * Catálogos activos que necesitan los formularios de la app y del panel.
   * Solo consulta los pedidos en `incluir` (por defecto, todos).
   */
  async consultar(filtro: FiltroCatalogosDto = {}) {
    const activo = { activo: true };
    const consultas: Record<Catalogo, () => Promise<unknown>> = {
      categorias_alimento: () =>
        this.prisma.categoria_alimento.findMany({
          where: activo,
          orderBy: { nombre: 'asc' },
          select: {
            id: true,
            codigo: true,
            nombre: true,
            requiere_refrigeracion: true,
            vida_util_dias_ref: true,
          },
        }),
      tipos_alimento: () =>
        this.prisma.tipo_alimento.findMany({
          where: activo,
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
      unidades_medida: () =>
        this.prisma.unidad_medida.findMany({
          where: activo,
          orderBy: { id: 'asc' },
          select: { id: true, codigo: true, nombre: true, factor_a_kg: true },
        }),
      tipos_vehiculo: () =>
        this.prisma.tipo_vehiculo.findMany({
          where: activo,
          orderBy: { capacidad_referencia_kg: 'asc' },
          select: {
            id: true,
            codigo: true,
            nombre: true,
            capacidad_referencia_kg: true,
            permite_refrigeracion: true,
          },
        }),
      motivos: () =>
        this.prisma.motivo.findMany({
          where: {
            ...activo,
            ...(filtro.ambito ? { ambito: filtro.ambito } : {}),
          },
          orderBy: [{ ambito: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            ambito: true,
            codigo: true,
            nombre: true,
            requiere_comentario: true,
          },
        }),
      tipos_incidencia: () =>
        this.prisma.tipo_incidencia.findMany({
          where: activo,
          orderBy: { id: 'asc' },
          select: {
            id: true,
            codigo: true,
            nombre: true,
            severidad_default: true,
            bloquea_donacion: true,
          },
        }),
      tipos_destino_distribucion: () =>
        this.prisma.tipo_destino_distribucion.findMany({
          where: activo,
          orderBy: { id: 'asc' },
          select: { id: true, codigo: true, nombre: true },
        }),
    };
    const pedidos = filtro.incluir?.length
      ? [...new Set(filtro.incluir)]
      : CATALOGOS;
    const resultados = await Promise.all(pedidos.map((c) => consultas[c]()));
    return Object.fromEntries(pedidos.map((c, i) => [c, resultados[i]]));
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
      SELECT id, nombre, direccion, ciudad, tiene_flota_propia, activo,
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
      if (actual) {
        await tx.$executeRaw`
          UPDATE banco_alimentos SET
            nombre = ${dto.nombre}, direccion = ${dto.direccion}, ciudad = ${dto.ciudad},
            ubicacion = ${sqlPunto(dto.ubicacion)},
            tiene_flota_propia = coalesce(${dto.tiene_flota_propia ?? null}::boolean, tiene_flota_propia)
          WHERE id = ${actual.id}::uuid`;
      } else {
        await tx.$executeRaw`
          INSERT INTO banco_alimentos (nombre, direccion, ciudad, ubicacion, tiene_flota_propia)
          VALUES (
            ${dto.nombre}, ${dto.direccion}, ${dto.ciudad}, ${sqlPunto(dto.ubicacion)},
            ${dto.tiene_flota_propia ?? false})`;
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
