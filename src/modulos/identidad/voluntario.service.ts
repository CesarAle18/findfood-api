import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { UsuarioAutenticado } from '../../comun/auth/tipos';
import { violaUnicidad } from '../../comun/http/errores-pg';
import { conflicto, noProcesable, prohibido } from '../../comun/http/problema';
import { sqlPunto } from '../../comun/geo';
import { PrismaService, type Tx } from '../../comun/prisma/prisma.service';
import { fechaBogota, horaComoDate } from '../../comun/tiempo';
import { TrazabilidadService } from '../../comun/trazabilidad/trazabilidad.service';
import { ArchivosService } from '../evidencias/archivos.service';
import type {
  DisponibilidadDto,
  SolicitudVoluntarioDto,
  UbicacionVoluntarioDto,
} from './identidad.dto';

const EDAD_MINIMA = 18;

export interface VoluntarioPropio {
  id: string;
  usuario_id: string;
  capacidad_carga_kg: number;
  tiene_refrigeracion: boolean;
}

@Injectable()
export class VoluntarioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly archivos: ArchivosService,
    private readonly trazabilidad: TrazabilidadService,
  ) {}

  /** Perfil de voluntario APROBADO del usuario (el rol VOLUNTARIO ya lo exige el guard). */
  async propio(
    usuarioId: string,
    db: Pick<Tx, 'voluntario'> = this.prisma,
  ): Promise<VoluntarioPropio> {
    const v = await db.voluntario.findUnique({
      where: { usuario_id: usuarioId },
      select: {
        id: true,
        usuario_id: true,
        capacidad_carga_kg: true,
        tiene_refrigeracion: true,
        estado_verificacion: true,
        deleted_at: true,
      },
    });
    if (!v || v.deleted_at || v.estado_verificacion !== 'APROBADA') {
      throw prohibido(
        'sin-perfil-voluntario',
        'No tienes un perfil de voluntario aprobado',
      );
    }
    return {
      id: v.id,
      usuario_id: v.usuario_id,
      capacidad_carga_kg: Number(v.capacidad_carga_kg),
      tiene_refrigeracion: v.tiene_refrigeracion,
    };
  }

  /**
   * POST /v1/voluntario/solicitud: crea (o renueva tras un rechazo) el perfil,
   * el rol VOLUNTARIO inactivo y la verificación PENDIENTE. El rol se activa
   * por disparador cuando el administrador aprueba (DDL §17.2).
   */
  async solicitar(
    usuario: UsuarioAutenticado,
    dto: SolicitudVoluntarioDto,
    peticion?: Request,
  ) {
    const hoy = fechaBogota();
    const [anio, mes, dia] = hoy.split('-').map(Number);
    const limite = `${anio - EDAD_MINIMA}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    if (dto.fecha_nacimiento > limite) {
      throw noProcesable(
        'edad-minima',
        `Debes tener al menos ${EDAD_MINIMA} años para ser voluntario`,
      );
    }

    const documentos = ['documentos-identidad'] as const;
    await this.archivos.validar(
      dto.url_foto_vehiculo,
      usuario.id,
      documentos,
      'url_foto_vehiculo',
    );
    await this.archivos.validar(
      dto.documento_frente,
      usuario.id,
      documentos,
      'documento_frente',
    );
    if (dto.documento_reverso) {
      await this.archivos.validar(
        dto.documento_reverso,
        usuario.id,
        documentos,
        'documento_reverso',
      );
    }
    if (dto.selfie)
      await this.archivos.validar(dto.selfie, usuario.id, documentos, 'selfie');

    try {
      return await this.prisma.transaccion(async (tx) => {
        const vehiculo = await tx.tipo_vehiculo.findFirst({
          where: { id: dto.tipo_vehiculo_id, activo: true },
          select: { id: true },
        });
        if (!vehiculo)
          throw noProcesable(
            'tipo-vehiculo-invalido',
            'El tipo de vehículo no existe',
          );

        const existente = await tx.voluntario.findUnique({
          where: { usuario_id: usuario.id },
          select: { estado_verificacion: true },
        });
        if (existente?.estado_verificacion === 'PENDIENTE') {
          throw conflicto(
            'solicitud-en-curso',
            'Ya tienes una solicitud de voluntario en revisión',
          );
        }
        if (existente?.estado_verificacion === 'APROBADA') {
          throw conflicto('ya-es-voluntario', 'Ya eres voluntario');
        }

        const [{ id: voluntarioId }] = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO voluntario
            (usuario_id, tipo_vehiculo_id, fecha_nacimiento, es_grupo, organizacion,
             placa_vehiculo, url_foto_vehiculo, capacidad_carga_kg, capacidad_volumen_m3,
             tiene_refrigeracion, ubicacion_base, radio_cobertura_km, disponible, estado_verificacion)
          VALUES (
            ${usuario.id}::uuid, ${dto.tipo_vehiculo_id}::smallint, ${dto.fecha_nacimiento}::date,
            ${dto.es_grupo}, ${dto.es_grupo ? dto.organizacion : null},
            ${dto.placa_vehiculo}, ${dto.url_foto_vehiculo}, ${dto.capacidad_carga_kg}::numeric,
            ${dto.capacidad_volumen_m3 ?? null}::numeric, ${dto.tiene_refrigeracion},
            ${sqlPunto(dto.ubicacion_base)}, ${dto.radio_cobertura_km}::numeric,
            false, 'PENDIENTE')
          ON CONFLICT (usuario_id) DO UPDATE SET
            tipo_vehiculo_id     = EXCLUDED.tipo_vehiculo_id,
            fecha_nacimiento     = EXCLUDED.fecha_nacimiento,
            es_grupo             = EXCLUDED.es_grupo,
            organizacion         = EXCLUDED.organizacion,
            placa_vehiculo       = EXCLUDED.placa_vehiculo,
            url_foto_vehiculo    = EXCLUDED.url_foto_vehiculo,
            capacidad_carga_kg   = EXCLUDED.capacidad_carga_kg,
            capacidad_volumen_m3 = EXCLUDED.capacidad_volumen_m3,
            tiene_refrigeracion  = EXCLUDED.tiene_refrigeracion,
            ubicacion_base       = EXCLUDED.ubicacion_base,
            radio_cobertura_km   = EXCLUDED.radio_cobertura_km,
            disponible           = false,
            estado_verificacion  = 'PENDIENTE',
            verificado_por       = NULL,
            verificado_at        = NULL,
            deleted_at           = NULL
          RETURNING id`;

        const rol = await tx.rol.findUniqueOrThrow({
          where: { codigo: 'VOLUNTARIO' },
        });
        await tx.usuario_rol.upsert({
          where: {
            usuario_id_rol_id: { usuario_id: usuario.id, rol_id: rol.id },
          },
          create: { usuario_id: usuario.id, rol_id: rol.id, activo: false },
          update: { activo: false },
        });

        const verificacion = await tx.verificacion_identidad.create({
          data: {
            usuario_id: usuario.id,
            url_documento_frente: dto.documento_frente,
            url_documento_reverso: dto.documento_reverso ?? null,
            url_selfie: dto.selfie ?? null,
          },
          select: { id: true, estado: true, created_at: true },
        });

        await this.trazabilidad.auditar(tx, {
          usuarioId: usuario.id,
          accion: 'SOLICITAR',
          entidad: 'voluntario',
          entidadId: voluntarioId,
          nuevos: {
            placa_vehiculo: dto.placa_vehiculo,
            verificacion_id: verificacion.id,
          },
          peticion,
        });

        return { voluntario_id: voluntarioId, verificacion };
      });
    } catch (err) {
      if (violaUnicidad(err, 'uq_voluntario_placa')) {
        throw conflicto(
          'placa-registrada',
          'Esa placa ya está registrada por otro voluntario',
        );
      }
      if (violaUnicidad(err, 'uq_verificacion_pendiente')) {
        throw conflicto(
          'solicitud-en-curso',
          'Ya tienes una solicitud de voluntario en revisión',
        );
      }
      throw err;
    }
  }

  /** Reemplaza las franjas: sin DELETE (ADR-10), las anteriores quedan inactivas. */
  async reemplazarDisponibilidad(
    usuario: UsuarioAutenticado,
    dto: DisponibilidadDto,
  ) {
    const franjas = dto.franjas.map((f) => ({
      dia_semana: f.dia_semana,
      hora_inicio: f.hora_inicio,
      hora_fin: f.hora_fin,
      inicio: horaComoDate(f.hora_inicio),
      fin: horaComoDate(f.hora_fin),
    }));
    for (const f of franjas) {
      if (f.fin <= f.inicio) {
        throw noProcesable(
          'franja-invalida',
          `La franja ${f.hora_inicio}-${f.hora_fin} termina antes de empezar`,
        );
      }
    }
    for (let dia = 0; dia <= 6; dia++) {
      const delDia = franjas
        .filter((f) => f.dia_semana === dia)
        .sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
      for (let i = 1; i < delDia.length; i++) {
        if (delDia[i].inicio < delDia[i - 1].fin) {
          throw noProcesable(
            'franjas-solapadas',
            `Hay franjas solapadas el día ${dia}`,
          );
        }
      }
    }

    const voluntario = await this.propio(usuario.id);
    await this.prisma.transaccion(async (tx) => {
      await tx.voluntario_disponibilidad.updateMany({
        where: { voluntario_id: voluntario.id },
        data: { activo: false },
      });
      for (const f of franjas) {
        await tx.voluntario_disponibilidad.upsert({
          where: {
            voluntario_id_dia_semana_hora_inicio: {
              voluntario_id: voluntario.id,
              dia_semana: f.dia_semana,
              hora_inicio: f.inicio,
            },
          },
          create: {
            voluntario_id: voluntario.id,
            dia_semana: f.dia_semana,
            hora_inicio: f.inicio,
            hora_fin: f.fin,
          },
          update: { hora_fin: f.fin, activo: true },
        });
      }
      if (!franjas.length) {
        await tx.voluntario.update({
          where: { id: voluntario.id },
          data: { disponible: false },
        });
      }
    });
    return { franjas: dto.franjas };
  }

  /** Interruptor de intención: sin horario ni ubicación base no hay a quién ofrecer. */
  async cambiarDisponible(usuario: UsuarioAutenticado, disponible: boolean) {
    const voluntario = await this.propio(usuario.id);
    if (disponible) {
      const [{ franjas, con_ubicacion }] = await this.prisma.$queryRaw<
        { franjas: number; con_ubicacion: boolean }[]
      >`SELECT (SELECT count(*)::int FROM voluntario_disponibilidad
                  WHERE voluntario_id = v.id AND activo) AS franjas,
               v.ubicacion_base IS NOT NULL AS con_ubicacion
          FROM voluntario v WHERE v.id = ${voluntario.id}::uuid`;
      if (!franjas) {
        throw noProcesable(
          'sin-horario',
          'Registra al menos una franja de disponibilidad',
        );
      }
      if (!con_ubicacion) {
        throw noProcesable('sin-ubicacion-base', 'Registra tu ubicación base');
      }
    }
    await this.prisma.voluntario.update({
      where: { id: voluntario.id },
      data: { disponible },
    });
    return { disponible };
  }

  /** Muestra periódica de la última posición (§9.2); el seguimiento en vivo va por Realtime. */
  async registrarUbicacion(
    usuario: UsuarioAutenticado,
    dto: UbicacionVoluntarioDto,
  ) {
    const voluntario = await this.propio(usuario.id);
    await this.prisma.$executeRaw`
      UPDATE voluntario
         SET ultima_ubicacion = ${sqlPunto(dto)}, ultima_ubicacion_at = now()
       WHERE id = ${voluntario.id}::uuid`;
    return { registrada: true };
  }
}
