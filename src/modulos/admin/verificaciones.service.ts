import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { UsuarioAutenticado } from '../../comun/auth/tipos';
import { conflicto, noEncontrado } from '../../comun/http/problema';
import { validarMotivo } from '../../comun/motivos';
import { PrismaService } from '../../comun/prisma/prisma.service';
import { TrazabilidadService } from '../../comun/trazabilidad/trazabilidad.service';
import type { Pagina } from '../../comun/validacion';
import { ArchivosService } from '../evidencias/archivos.service';
import { NotificacionesService } from '../notificaciones/notificaciones.service';
import type {
  ListarVerificacionesDto,
  RechazarVerificacionDto,
} from './admin.dto';

/** Los documentos de identidad solo los ve el ADMIN, con URLs de 60 s (§13.3). */
const VIGENCIA_DOCUMENTOS_S = 60;

@Injectable()
export class VerificacionesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly archivos: ArchivosService,
    private readonly notificaciones: NotificacionesService,
    private readonly trazabilidad: TrazabilidadService,
  ) {}

  async listar(filtro: ListarVerificacionesDto): Promise<Pagina<unknown>> {
    const donde = { estado: filtro.estado };
    const [datos, total] = await Promise.all([
      this.prisma.verificacion_identidad.findMany({
        where: donde,
        orderBy: { created_at: 'asc' },
        take: filtro.limite,
        skip: filtro.desplazamiento,
        select: {
          id: true,
          estado: true,
          created_at: true,
          revisado_at: true,
          usuario_verificacion_identidad_usuario_idTousuario: {
            select: {
              id: true,
              email: true,
              nombres: true,
              apellidos: true,
              telefono: true,
              voluntario_voluntario_usuario_idTousuario: {
                select: {
                  placa_vehiculo: true,
                  capacidad_carga_kg: true,
                  tiene_refrigeracion: true,
                  es_grupo: true,
                  organizacion: true,
                  tipo_vehiculo: { select: { nombre: true } },
                },
              },
            },
          },
        },
      }),
      this.prisma.verificacion_identidad.count({ where: donde }),
    ]);
    return {
      datos: datos.map(
        ({ usuario_verificacion_identidad_usuario_idTousuario: u, ...v }) => {
          const {
            voluntario_voluntario_usuario_idTousuario: voluntario,
            ...usuario
          } = u;
          return { ...v, usuario, voluntario };
        },
      ),
      total,
      limite: filtro.limite,
      desplazamiento: filtro.desplazamiento,
    };
  }

  async detalle(id: string) {
    const v = await this.prisma.verificacion_identidad.findUnique({
      where: { id },
      select: {
        id: true,
        estado: true,
        observacion: true,
        created_at: true,
        revisado_at: true,
        url_documento_frente: true,
        url_documento_reverso: true,
        url_selfie: true,
        motivo: { select: { codigo: true, nombre: true } },
        usuario_verificacion_identidad_usuario_idTousuario: {
          select: {
            id: true,
            email: true,
            nombres: true,
            apellidos: true,
            telefono: true,
            voluntario_voluntario_usuario_idTousuario: {
              select: {
                id: true,
                fecha_nacimiento: true,
                placa_vehiculo: true,
                url_foto_vehiculo: true,
                capacidad_carga_kg: true,
                capacidad_volumen_m3: true,
                tiene_refrigeracion: true,
                radio_cobertura_km: true,
                es_grupo: true,
                organizacion: true,
                tipo_vehiculo: { select: { codigo: true, nombre: true } },
              },
            },
          },
        },
      },
    });
    if (!v) throw noEncontrado('Verificación');
    const {
      usuario_verificacion_identidad_usuario_idTousuario: u,
      url_documento_frente,
      url_documento_reverso,
      url_selfie,
      ...resto
    } = v;
    const {
      voluntario_voluntario_usuario_idTousuario: voluntario,
      ...usuario
    } = u;
    const firmar = (ruta: string | null | undefined) =>
      this.archivos.urlLectura(ruta, VIGENCIA_DOCUMENTOS_S);
    return {
      ...resto,
      usuario,
      voluntario: voluntario
        ? {
            ...voluntario,
            url_foto_vehiculo: await firmar(voluntario.url_foto_vehiculo),
          }
        : null,
      documentos: {
        frente: await firmar(url_documento_frente),
        reverso: await firmar(url_documento_reverso),
        selfie: await firmar(url_selfie),
        vigencia_segundos: VIGENCIA_DOCUMENTOS_S,
      },
    };
  }

  /** Aprobar activa el rol VOLUNTARIO por disparador (DDL §17.2). */
  async aprobar(admin: UsuarioAutenticado, id: string, peticion?: Request) {
    await this.prisma.transaccion(async (tx) => {
      const { count } = await tx.verificacion_identidad.updateMany({
        where: { id, estado: 'PENDIENTE' },
        data: {
          estado: 'APROBADA',
          revisado_por: admin.id,
          revisado_at: new Date(),
        },
      });
      if (!count) await this.noPendiente(id);
      const v = await tx.verificacion_identidad.findUniqueOrThrow({
        where: { id },
        select: { usuario_id: true },
      });
      await this.notificaciones.encolar(tx, {
        usuarioId: v.usuario_id,
        codigo: 'VERIFICACION_APROBADA',
      });
      await this.trazabilidad.auditar(tx, {
        usuarioId: admin.id,
        accion: 'APROBAR',
        entidad: 'verificacion_identidad',
        entidadId: id,
        nuevos: { estado: 'APROBADA' },
        peticion,
      });
    });
    return this.detalle(id);
  }

  async rechazar(
    admin: UsuarioAutenticado,
    id: string,
    dto: RechazarVerificacionDto,
    peticion?: Request,
  ) {
    await this.prisma.transaccion(async (tx) => {
      const motivo = await validarMotivo(
        tx,
        dto.motivo_id,
        'RECHAZO_VERIFICACION',
        dto.observacion,
      );
      const { count } = await tx.verificacion_identidad.updateMany({
        where: { id, estado: 'PENDIENTE' },
        data: {
          estado: 'RECHAZADA',
          revisado_por: admin.id,
          revisado_at: new Date(),
          motivo_id: motivo.id,
          observacion: dto.observacion ?? null,
        },
      });
      if (!count) await this.noPendiente(id);
      const v = await tx.verificacion_identidad.findUniqueOrThrow({
        where: { id },
        select: { usuario_id: true },
      });
      await tx.voluntario.updateMany({
        where: { usuario_id: v.usuario_id },
        data: { estado_verificacion: 'RECHAZADA', disponible: false },
      });
      await this.notificaciones.encolar(tx, {
        usuarioId: v.usuario_id,
        codigo: 'VERIFICACION_RECHAZADA',
        variables: { motivo: motivo.nombre },
      });
      await this.trazabilidad.auditar(tx, {
        usuarioId: admin.id,
        accion: 'RECHAZAR',
        entidad: 'verificacion_identidad',
        entidadId: id,
        nuevos: { estado: 'RECHAZADA', motivo: motivo.codigo },
        peticion,
      });
    });
    return this.detalle(id);
  }

  private async noPendiente(id: string): Promise<never> {
    const existe = await this.prisma.verificacion_identidad.count({
      where: { id },
    });
    if (!existe) throw noEncontrado('Verificación');
    throw conflicto('verificacion-resuelta', 'La verificación ya fue resuelta');
  }
}
