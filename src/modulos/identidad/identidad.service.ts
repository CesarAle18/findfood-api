import { Injectable } from '@nestjs/common';
import type { UsuarioAutenticado } from '../../comun/auth/tipos';
import { noEncontrado } from '../../comun/http/problema';
import { PrismaService } from '../../comun/prisma/prisma.service';
import { dateComoHora } from '../../comun/tiempo';
import type {
  ActualizarPerfilDto,
  RegistrarDispositivoDto,
} from './identidad.dto';

@Injectable()
export class IdentidadService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /v1/me: la app decide a qué pantalla ir con `pendientes`. */
  async perfil(usuario: UsuarioAutenticado) {
    const u = await this.prisma.usuario.findUniqueOrThrow({
      where: { id: usuario.id },
      select: {
        id: true,
        email: true,
        nombres: true,
        apellidos: true,
        telefono: true,
        url_foto: true,
        estado: true,
        email_verificado_at: true,
        debe_cambiar_password: true,
        idioma: true,
        acepto_terminos_at: true,
        created_at: true,
        donante: {
          select: {
            id: true,
            activo: true,
            total_donaciones: true,
            total_kg_donados: true,
            calificacion_promedio: true,
          },
        },
        voluntario_voluntario_usuario_idTousuario: {
          select: {
            id: true,
            estado_verificacion: true,
            disponible: true,
            placa_vehiculo: true,
            capacidad_carga_kg: true,
            tiene_refrigeracion: true,
            radio_cobertura_km: true,
            total_entregas: true,
            calificacion_promedio: true,
            tipo_vehiculo: { select: { id: true, codigo: true, nombre: true } },
            voluntario_disponibilidad: {
              where: { activo: true },
              orderBy: [{ dia_semana: 'asc' }, { hora_inicio: 'asc' }],
              select: { dia_semana: true, hora_inicio: true, hora_fin: true },
            },
          },
        },
      },
    });

    const vol = u.voluntario_voluntario_usuario_idTousuario;
    let voluntario = null;
    if (vol) {
      const [ubicacion] = await this.prisma.$queryRaw<
        { lat: number; lng: number }[]
      >`
        SELECT ST_Y(ubicacion_base::geometry) AS lat, ST_X(ubicacion_base::geometry) AS lng
          FROM voluntario WHERE id = ${vol.id}::uuid AND ubicacion_base IS NOT NULL`;
      // Relación 1:1 errónea por el índice parcial: se consulta la tabla hija.
      const verificacion = await this.prisma.verificacion_identidad.findFirst({
        where: { usuario_id: usuario.id },
        orderBy: { created_at: 'desc' },
        select: {
          estado: true,
          observacion: true,
          created_at: true,
          revisado_at: true,
          motivo: { select: { nombre: true } },
        },
      });
      const { voluntario_disponibilidad, ...resto } = vol;
      voluntario = {
        ...resto,
        ubicacion_base: ubicacion ?? null,
        disponibilidad: voluntario_disponibilidad.map((f) => ({
          dia_semana: f.dia_semana,
          hora_inicio: dateComoHora(f.hora_inicio),
          hora_fin: dateComoHora(f.hora_fin),
        })),
        verificacion: verificacion
          ? {
              estado: verificacion.estado,
              observacion: verificacion.observacion,
              motivo: verificacion.motivo?.nombre ?? null,
              solicitada_at: verificacion.created_at,
              revisada_at: verificacion.revisado_at,
            }
          : null,
      };
    }

    const pendientes: string[] = [];
    if (!u.telefono) pendientes.push('TELEFONO');
    if (!u.email_verificado_at) pendientes.push('CONFIRMAR_CORREO');
    if (u.debe_cambiar_password) pendientes.push('CAMBIAR_PASSWORD');
    if (
      !u.acepto_terminos_at &&
      !usuario.roles.some((r) => r === 'ADMIN' || r === 'ASESOR_BANCO')
    ) {
      pendientes.push('ACEPTAR_TERMINOS');
    }

    const {
      donante,
      voluntario_voluntario_usuario_idTousuario: _v,
      email_verificado_at,
      ...perfil
    } = u;
    return {
      ...perfil,
      email_verificado: Boolean(email_verificado_at),
      roles: usuario.roles,
      pendientes,
      donante: donante?.activo ? donante : null,
      voluntario,
    };
  }

  /**
   * Completa el perfil. Si la cuenta estaba PENDIENTE con el correo confirmado
   * (registro con Google), registrar el teléfono la activa (§13.2).
   */
  async actualizarPerfil(
    usuario: UsuarioAutenticado,
    dto: ActualizarPerfilDto,
  ) {
    await this.prisma.transaccion(async (tx) => {
      const actual = await tx.usuario.findUniqueOrThrow({
        where: { id: usuario.id },
        select: {
          estado: true,
          telefono: true,
          email_verificado_at: true,
          acepto_terminos_at: true,
        },
      });
      const telefono = dto.telefono ?? actual.telefono;
      const activar =
        actual.estado === 'PENDIENTE_CONFIRMACION' &&
        Boolean(actual.email_verificado_at) &&
        Boolean(telefono);
      await tx.usuario.update({
        where: { id: usuario.id },
        data: {
          ...(dto.nombres !== undefined ? { nombres: dto.nombres } : {}),
          ...(dto.apellidos !== undefined
            ? { apellidos: dto.apellidos || null }
            : {}),
          ...(dto.telefono !== undefined ? { telefono: dto.telefono } : {}),
          ...(dto.acepto_terminos && !actual.acepto_terminos_at
            ? { acepto_terminos_at: new Date() }
            : {}),
          ...(activar ? { estado: 'ACTIVO' as const } : {}),
          updated_by: usuario.id,
        },
      });
    });
    return this.perfil({ ...usuario });
  }

  async impacto(usuario: UsuarioAutenticado) {
    const [donante, voluntario] = await Promise.all([
      this.prisma.donante.findUnique({
        where: { usuario_id: usuario.id },
        select: {
          id: true,
          total_donaciones: true,
          total_kg_donados: true,
          calificacion_promedio: true,
          total_calificaciones: true,
        },
      }),
      this.prisma.voluntario.findUnique({
        where: { usuario_id: usuario.id },
        select: {
          id: true,
          total_entregas: true,
          total_kg_transportados: true,
          calificacion_promedio: true,
          estado_verificacion: true,
        },
      }),
    ]);

    let resumenDonante = null;
    if (donante) {
      const [vista] = await this.prisma.$queryRaw<
        {
          donaciones_entregadas: bigint;
          kg_entregados: unknown;
          donaciones_canceladas: bigint;
          primera_donacion: Date | null;
          ultima_donacion: Date | null;
        }[]
      >`SELECT donaciones_entregadas, kg_entregados, donaciones_canceladas,
               primera_donacion, ultima_donacion
          FROM vw_impacto_donante WHERE donante_id = ${donante.id}::uuid`;
      resumenDonante = {
        ...donante,
        donaciones_entregadas: vista?.donaciones_entregadas ?? 0,
        kg_entregados: vista?.kg_entregados ?? 0,
        donaciones_canceladas: vista?.donaciones_canceladas ?? 0,
        primera_donacion: vista?.primera_donacion ?? null,
        ultima_donacion: vista?.ultima_donacion ?? null,
      };
    }

    let resumenVoluntario = null;
    if (voluntario && voluntario.estado_verificacion === 'APROBADA') {
      const completadas = await this.prisma.asignacion.count({
        where: { voluntario_id: voluntario.id, estado: 'COMPLETADA' },
      });
      resumenVoluntario = {
        ...voluntario,
        recolecciones_completadas: completadas,
      };
    }

    return { donante: resumenDonante, voluntario: resumenVoluntario };
  }

  /** Un token pertenece a un solo dispositivo: si cambió de dueño, se reasigna. */
  registrarDispositivo(
    usuario: UsuarioAutenticado,
    dto: RegistrarDispositivoDto,
  ) {
    const datos = {
      usuario_id: usuario.id,
      plataforma: dto.plataforma,
      modelo: dto.modelo ?? null,
      version_app: dto.version_app ?? null,
      activo: true,
      ultimo_uso_at: new Date(),
    };
    return this.prisma.dispositivo_push.upsert({
      where: { token_push: dto.token_push },
      create: { ...datos, token_push: dto.token_push },
      update: datos,
      select: {
        id: true,
        plataforma: true,
        modelo: true,
        version_app: true,
        activo: true,
      },
    });
  }

  async eliminarDispositivo(
    usuario: UsuarioAutenticado,
    id: string,
  ): Promise<void> {
    const { count } = await this.prisma.dispositivo_push.deleteMany({
      where: { id, usuario_id: usuario.id },
    });
    if (!count) throw noEncontrado('Dispositivo');
  }
}
