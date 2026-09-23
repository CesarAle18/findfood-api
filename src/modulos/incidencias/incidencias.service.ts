import { Injectable } from '@nestjs/common';
import { esPersonal, type UsuarioAutenticado } from '../../comun/auth/tipos';
import { generarCodigo } from '../../comun/codigos';
import { type Coordenada, sqlPuntoOpcional } from '../../comun/geo';
import {
  conflicto,
  noEncontrado,
  noProcesable,
  prohibido,
} from '../../comun/http/problema';
import { PrismaService, type Tx } from '../../comun/prisma/prisma.service';
import { TrazabilidadService } from '../../comun/trazabilidad/trazabilidad.service';
import type { Pagina } from '../../comun/validacion';
import type { Prisma } from '../../generated/prisma/client';
import type { severidad } from '../../generated/prisma/enums';
import type {
  ContextoIncidenciaDto,
  CrearIncidenciaDto,
  ListarIncidenciasDto,
} from './incidencias.dto';

export interface NuevaIncidencia extends ContextoIncidenciaDto {
  tipoCodigo?: string;
  tipoId?: number;
  descripcion: string;
  reportadaPor: string;
  nivel?: severidad;
  ubicacion?: Coordenada | null;
}

@Injectable()
export class IncidenciasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trazabilidad: TrazabilidadService,
  ) {}

  /**
   * Registra la incidencia dentro de la transacción de quien la origina. La
   * API también la usa para incidencias que detecta el sistema (§6.7).
   */
  async registrar(
    tx: Tx,
    n: NuevaIncidencia,
  ): Promise<{ id: string; codigo: string }> {
    const tipo = await tx.tipo_incidencia.findFirst({
      where: {
        activo: true,
        ...(n.tipoId ? { id: n.tipoId } : { codigo: n.tipoCodigo ?? 'OTRO' }),
      },
      select: { id: true, severidad_default: true },
    });
    if (!tipo)
      throw noProcesable(
        'tipo-incidencia-invalido',
        'El tipo de incidencia no existe',
      );
    if (!n.donacion_id && !n.asignacion_id && !n.parada_id && !n.recepcion_id) {
      throw noProcesable(
        'incidencia-sin-contexto',
        'Indica al menos una donación, asignación, parada o recepción',
      );
    }
    const codigo = generarCodigo('INC');
    const [{ id }] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO incidencia
        (codigo, tipo_incidencia_id, reportada_por, donacion_id, asignacion_id, parada_id,
         recepcion_id, descripcion, nivel, ubicacion)
      VALUES (
        ${codigo}, ${tipo.id}::smallint, ${n.reportadaPor}::uuid,
        ${n.donacion_id ?? null}::uuid, ${n.asignacion_id ?? null}::uuid,
        ${n.parada_id ?? null}::uuid, ${n.recepcion_id ?? null}::uuid,
        ${n.descripcion}, ${n.nivel ?? tipo.severidad_default}::severidad,
        ${sqlPuntoOpcional(n.ubicacion)})
      RETURNING id`;
    await this.trazabilidad.registrar(tx, {
      ambito: 'INCIDENCIA',
      entidad: { incidenciaId: id },
      nuevo: 'ABIERTA',
      usuarioId: n.reportadaPor,
      ubicacion: n.ubicacion,
    });
    return { id, codigo };
  }

  async crear(usuario: UsuarioAutenticado, dto: CrearIncidenciaDto) {
    await this.autorizarContexto(usuario, dto);
    const { id } = await this.prisma.transaccion((tx) =>
      this.registrar(tx, {
        tipoId: dto.tipo_incidencia_id,
        descripcion: dto.descripcion,
        nivel: dto.nivel,
        ubicacion: dto.ubicacion,
        donacion_id: dto.donacion_id,
        asignacion_id: dto.asignacion_id,
        parada_id: dto.parada_id,
        recepcion_id: dto.recepcion_id,
        reportadaPor: usuario.id,
      }),
    );
    return this.detalle(usuario, id);
  }

  async listar(
    usuario: UsuarioAutenticado,
    filtro: ListarIncidenciasDto,
  ): Promise<Pagina<unknown>> {
    const donde: Prisma.incidenciaWhereInput = {
      ...(esPersonal(usuario) ? {} : { reportada_por: usuario.id }),
      ...(filtro.estado ? { estado: filtro.estado } : {}),
      ...(filtro.donacion_id ? { donacion_id: filtro.donacion_id } : {}),
    };
    const [datos, total] = await Promise.all([
      this.prisma.incidencia.findMany({
        where: donde,
        orderBy: { created_at: 'desc' },
        take: filtro.limite,
        skip: filtro.desplazamiento,
        select: this.seleccion,
      }),
      this.prisma.incidencia.count({ where: donde }),
    ]);
    return {
      datos,
      total,
      limite: filtro.limite,
      desplazamiento: filtro.desplazamiento,
    };
  }

  async detalle(usuario: UsuarioAutenticado, id: string) {
    const incidencia = await this.prisma.incidencia.findUnique({
      where: { id },
      select: this.seleccion,
    });
    if (
      !incidencia ||
      (!esPersonal(usuario) && incidencia.reportada_por !== usuario.id)
    ) {
      throw noEncontrado('Incidencia');
    }
    return incidencia;
  }

  /** ADMIN (§11). Las acciones sobre la donación se hacen con cancelar o reasignar. */
  async resolver(usuario: UsuarioAutenticado, id: string, resolucion: string) {
    await this.prisma.transaccion(async (tx) => {
      const actual = await tx.incidencia.findUnique({
        where: { id },
        select: { estado: true },
      });
      if (!actual) throw noEncontrado('Incidencia');
      if (actual.estado === 'RESUELTA' || actual.estado === 'CERRADA') {
        throw conflicto('incidencia-cerrada', 'La incidencia ya fue resuelta');
      }
      await tx.incidencia.update({
        where: { id },
        data: {
          estado: 'RESUELTA',
          resolucion,
          resuelta_at: new Date(),
          resuelta_por: usuario.id,
        },
      });
      await this.trazabilidad.registrar(tx, {
        ambito: 'INCIDENCIA',
        entidad: { incidenciaId: id },
        anterior: actual.estado,
        nuevo: 'RESUELTA',
        usuarioId: usuario.id,
        motivo: resolucion,
      });
    });
    return this.detalle(usuario, id);
  }

  /** Personal: toma la incidencia para revisarla. */
  async revisar(usuario: UsuarioAutenticado, id: string) {
    await this.prisma.transaccion(async (tx) => {
      const actual = await tx.incidencia.findUnique({
        where: { id },
        select: { estado: true },
      });
      if (!actual) throw noEncontrado('Incidencia');
      if (actual.estado !== 'ABIERTA') {
        throw conflicto(
          'incidencia-no-abierta',
          'Solo se toma una incidencia ABIERTA',
        );
      }
      await tx.incidencia.update({
        where: { id },
        data: { estado: 'EN_REVISION', asignada_a: usuario.id },
      });
      await this.trazabilidad.registrar(tx, {
        ambito: 'INCIDENCIA',
        entidad: { incidenciaId: id },
        anterior: 'ABIERTA',
        nuevo: 'EN_REVISION',
        usuarioId: usuario.id,
      });
    });
    return this.detalle(usuario, id);
  }

  private readonly seleccion = {
    id: true,
    codigo: true,
    descripcion: true,
    nivel: true,
    estado: true,
    donacion_id: true,
    asignacion_id: true,
    parada_id: true,
    recepcion_id: true,
    reportada_por: true,
    asignada_a: true,
    resolucion: true,
    resuelta_at: true,
    created_at: true,
    updated_at: true,
    tipo_incidencia: {
      select: { id: true, codigo: true, nombre: true, bloquea_donacion: true },
    },
    usuario_incidencia_reportada_porTousuario: {
      select: { nombres: true, apellidos: true },
    },
  } satisfies Prisma.incidenciaSelect;

  /** Quien reporta debe participar en lo que reporta (o ser personal del banco). */
  private async autorizarContexto(
    usuario: UsuarioAutenticado,
    c: ContextoIncidenciaDto,
  ) {
    if (esPersonal(usuario)) return;
    const participa = async (): Promise<boolean> => {
      if (c.recepcion_id) return false;
      if (c.donacion_id) {
        const d = await this.prisma.donacion.findUnique({
          where: { id: c.donacion_id },
          select: { donante: { select: { usuario_id: true } } },
        });
        if (!d) return false;
        if (d.donante.usuario_id !== usuario.id) {
          // donacion.asignacion es 1:1 por error de introspección: se consulta asignacion.
          const n = await this.prisma.asignacion.count({
            where: {
              donacion_id: c.donacion_id,
              voluntario: { usuario_id: usuario.id },
              estado: { in: ['ACEPTADA', 'COMPLETADA'] },
            },
          });
          if (!n) return false;
        }
      }
      if (c.asignacion_id) {
        const n = await this.prisma.asignacion.count({
          where: {
            id: c.asignacion_id,
            OR: [
              { voluntario: { usuario_id: usuario.id } },
              { donacion: { donante: { usuario_id: usuario.id } } },
            ],
          },
        });
        if (!n) return false;
      }
      if (c.parada_id) {
        const n = await this.prisma.parada_ruta.count({
          where: {
            id: c.parada_id,
            OR: [
              { ruta: { voluntario: { usuario_id: usuario.id } } },
              { donacion: { donante: { usuario_id: usuario.id } } },
            ],
          },
        });
        if (!n) return false;
      }
      return true;
    };
    if (!(await participa())) {
      throw prohibido(
        'incidencia-ajena',
        'Solo puedes reportar sobre donaciones o rutas en las que participas',
      );
    }
  }
}
