import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { tieneRol, type UsuarioAutenticado } from '../../comun/auth/tipos';
import { violaUnicidad } from '../../comun/http/errores-pg';
import {
  conflicto,
  noEncontrado,
  noProcesable,
} from '../../comun/http/problema';
import { validarMotivo } from '../../comun/motivos';
import { PrismaService, type Tx } from '../../comun/prisma/prisma.service';
import { TrazabilidadService } from '../../comun/trazabilidad/trazabilidad.service';
import type { estado_asignacion } from '../../generated/prisma/enums';
import { DonacionesService } from '../donaciones/donaciones.service';
import { VoluntarioService } from '../identidad/voluntario.service';
import { IncidenciasService } from '../incidencias/incidencias.service';
import { NotificacionesService } from '../notificaciones/notificaciones.service';
import type { CalificacionDto, RespuestaConMotivoDto } from './asignacion.dto';
import { MotorAsignacionService } from './motor.service';

export interface OpcionesCierre {
  estados?: estado_asignacion[];
  usuarioId?: string | null;
  motivo?: string;
  /** Avisar al voluntario que ya no debe recoger (DONACION_CANCELADA). */
  notificar?: boolean;
}

@Injectable()
export class AsignacionService {
  private readonly logger = new Logger(AsignacionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly motor: MotorAsignacionService,
    private readonly trazabilidad: TrazabilidadService,
    private readonly notificaciones: NotificacionesService,
    private readonly voluntarios: VoluntarioService,
    private readonly incidencias: IncidenciasService,
    @Inject(forwardRef(() => DonacionesService))
    private readonly donaciones: DonacionesService,
  ) {}

  ofrecerSiguiente(donacionId: string): Promise<string | null> {
    return this.motor.ofrecerSiguiente(donacionId);
  }

  /** Continúa la cascada sin hacer fallar la petición que la dispara. */
  private async continuarCascada(donacionId: string): Promise<void> {
    try {
      await this.motor.ofrecerSiguiente(donacionId);
    } catch (err) {
      this.logger.error(
        { err, donacionId },
        'No se pudo ofrecer al siguiente candidato',
      );
    }
  }

  // ===========================================================================
  // Primitivas transaccionales
  // ===========================================================================

  /**
   * Cierra las asignaciones vivas de una donación (cancelación, reasignación,
   * expiración). Si la asignación ya estaba en una ruta, su parada de recogida
   * queda OMITIDA.
   */
  async cerrarVigentes(
    tx: Tx,
    donacionId: string,
    estadoFinal: 'CANCELADA' | 'EXPIRADA',
    op: OpcionesCierre = {},
  ): Promise<number> {
    const estados = op.estados ?? ['OFRECIDA', 'ACEPTADA'];
    const cerradas = await tx.$queryRaw<
      {
        id: string;
        anterior: string;
        voluntario_id: string | null;
        ruta_id: string | null;
      }[]
    >`
      WITH previas AS (
        SELECT id, estado FROM asignacion
         WHERE donacion_id = ${donacionId}::uuid
           AND estado = ANY(${estados}::estado_asignacion[])
         FOR UPDATE)
      UPDATE asignacion a
         SET estado = ${estadoFinal}::estado_asignacion, finalizada_at = now()
        FROM previas p
       WHERE a.id = p.id
      RETURNING a.id, p.estado::text AS anterior, a.voluntario_id, a.ruta_id`;

    for (const a of cerradas) {
      await this.trazabilidad.registrar(tx, {
        ambito: 'ASIGNACION',
        entidad: { asignacionId: a.id },
        anterior: a.anterior,
        nuevo: estadoFinal,
        usuarioId: op.usuarioId,
        motivo: op.motivo,
      });
      if (a.ruta_id)
        await this.omitirParada(
          tx,
          a.ruta_id,
          donacionId,
          op.usuarioId,
          op.motivo,
        );
      if (op.notificar && a.voluntario_id) {
        const [v] = await tx.$queryRaw<
          { usuario_id: string; codigo: string }[]
        >`
          SELECT v.usuario_id, d.codigo FROM voluntario v, donacion d
           WHERE v.id = ${a.voluntario_id}::uuid AND d.id = ${donacionId}::uuid`;
        await this.notificaciones.encolar(tx, {
          usuarioId: v.usuario_id,
          codigo: 'DONACION_CANCELADA',
          donacionId,
          asignacionId: a.id,
          variables: { codigo: v.codigo },
        });
      }
    }
    return cerradas.length;
  }

  private async omitirParada(
    tx: Tx,
    rutaId: string,
    donacionId: string,
    usuarioId?: string | null,
    motivo?: string,
  ): Promise<void> {
    const paradas = await tx.$queryRaw<{ id: string; anterior: string }[]>`
      WITH previas AS (
        SELECT id, estado FROM parada_ruta
         WHERE ruta_id = ${rutaId}::uuid AND donacion_id = ${donacionId}::uuid
           AND estado IN ('PENDIENTE','EN_SITIO')
         FOR UPDATE)
      UPDATE parada_ruta p SET estado = 'OMITIDA'
        FROM previas x WHERE p.id = x.id
      RETURNING p.id, x.estado::text AS anterior`;
    for (const p of paradas) {
      await this.trazabilidad.registrar(tx, {
        ambito: 'PARADA',
        entidad: { paradaId: p.id },
        anterior: p.anterior,
        nuevo: 'OMITIDA',
        usuarioId,
        motivo,
      });
    }
  }

  /** Al confirmar la ENTREGA en la sede: ACEPTADA → COMPLETADA. */
  async completar(
    tx: Tx,
    donacionIds: string[],
    usuarioId: string,
  ): Promise<void> {
    if (!donacionIds.length) return;
    const filas = await tx.$queryRaw<{ id: string }[]>`
      UPDATE asignacion SET estado = 'COMPLETADA', finalizada_at = now()
       WHERE donacion_id = ANY(${donacionIds}::uuid[]) AND estado = 'ACEPTADA'
      RETURNING id`;
    for (const f of filas) {
      await this.trazabilidad.registrar(tx, {
        ambito: 'ASIGNACION',
        entidad: { asignacionId: f.id },
        anterior: 'ACEPTADA',
        nuevo: 'COMPLETADA',
        usuarioId,
      });
    }
  }

  /**
   * Recolección con la flota del banco (modo FLOTA_BANCO): cierra la oferta
   * viva y crea una asignación ya ACEPTADA con banco_ejecutor_id.
   */
  async asignarAFlota(
    tx: Tx,
    donacionId: string,
    bancoId: string,
    rutaId: string,
    usuarioId: string,
  ): Promise<string> {
    await this.cerrarVigentes(tx, donacionId, 'CANCELADA', {
      estados: ['OFRECIDA'],
      usuarioId,
      motivo: 'La recoge la flota del banco',
    });
    const [a] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO asignacion
        (donacion_id, banco_ejecutor_id, ruta_id, intento, estado, ofrecida_at, expira_at,
         respondida_at, aceptada_at)
      SELECT ${donacionId}::uuid, ${bancoId}::uuid, ${rutaId}::uuid,
             coalesce(max(intento), 0) + 1, 'ACEPTADA', now(), now() + interval '1 minute',
             now(), now()
        FROM asignacion WHERE donacion_id = ${donacionId}::uuid
      RETURNING id`;
    await this.trazabilidad.registrar(tx, {
      ambito: 'ASIGNACION',
      entidad: { asignacionId: a.id },
      nuevo: 'ACEPTADA',
      usuarioId,
      metadata: { flota_banco: true },
    });
    return a.id;
  }

  // ===========================================================================
  // Casos de uso del voluntario
  // ===========================================================================

  /** Ofertas vivas y aceptadas propias; el contacto del donante solo tras aceptar. */
  async ofertas(usuario: UsuarioAutenticado) {
    const voluntario = await this.voluntarios.propio(usuario.id);
    return this.prisma.$queryRaw`
      SELECT a.id, a.estado::text AS estado, a.intento, a.ofrecida_at, a.expira_at,
             a.aceptada_at, a.distancia_km, a.ruta_id,
             d.id AS donacion_id, d.codigo, d.titulo, d.estado::text AS donacion_estado,
             d.peso_estimado_kg, d.requiere_refrigeracion,
             d.ventana_recogida_inicio, d.ventana_recogida_fin,
             d.direccion_recogida, d.referencia_recogida,
             ST_Y(d.ubicacion_recogida::geometry) AS lat,
             ST_X(d.ubicacion_recogida::geometry) AS lng,
             al.id AS almacen_id, al.nombre AS almacen_nombre, al.direccion AS almacen_direccion,
             CASE WHEN a.estado = 'ACEPTADA'
                  THEN coalesce(d.contacto_nombre, u.nombres) END AS contacto_nombre,
             CASE WHEN a.estado = 'ACEPTADA'
                  THEN coalesce(d.contacto_telefono, u.telefono) END AS contacto_telefono,
             (SELECT json_agg(json_build_object(
                        'tipo', ta.nombre, 'cantidad', i.cantidad, 'unidad', um.codigo,
                        'peso_estimado_kg', i.peso_estimado_kg,
                        'requiere_refrigeracion', i.requiere_refrigeracion)
                      ORDER BY i.created_at)
                FROM donacion_item i
                JOIN tipo_alimento ta ON ta.id = i.tipo_alimento_id
                JOIN unidad_medida um ON um.id = i.unidad_medida_id
               WHERE i.donacion_id = d.id) AS productos
        FROM asignacion a
        JOIN donacion d  ON d.id = a.donacion_id
        JOIN donante dn  ON dn.id = d.donante_id
        JOIN usuario u   ON u.id = dn.usuario_id
        LEFT JOIN almacen al ON al.id = d.almacen_destino_id
       WHERE a.voluntario_id = ${voluntario.id}::uuid
         AND ((a.estado = 'OFRECIDA' AND a.expira_at > now()) OR a.estado = 'ACEPTADA')
       ORDER BY a.estado DESC, a.expira_at`;
  }

  /** Explica por qué una respuesta condicional no afectó ninguna fila. */
  private async motivoRespuestaFallida(
    tx: Tx,
    id: string,
    voluntarioId: string,
  ): Promise<never> {
    const a = await tx.asignacion.findUnique({
      where: { id },
      select: { voluntario_id: true, estado: true, expira_at: true },
    });
    if (!a || a.voluntario_id !== voluntarioId) throw noEncontrado('Oferta');
    if (
      a.estado === 'EXPIRADA' ||
      (a.estado === 'OFRECIDA' && a.expira_at <= new Date())
    ) {
      throw conflicto('oferta-vencida', 'La oferta ya venció');
    }
    throw conflicto(
      'oferta-ya-respondida',
      'La oferta ya fue respondida o cerrada',
      `Estado: ${a.estado}`,
    );
  }

  /** Aceptar (§6.7): una sentencia condicional evaluada por la base, sin carreras. */
  async aceptar(usuario: UsuarioAutenticado, id: string) {
    const voluntario = await this.voluntarios.propio(usuario.id);
    await this.prisma.transaccion(async (tx) => {
      const [aceptada] = await tx.$queryRaw<{ donacion_id: string }[]>`
        UPDATE asignacion
           SET estado = 'ACEPTADA', aceptada_at = now(), respondida_at = now()
         WHERE id = ${id}::uuid AND voluntario_id = ${voluntario.id}::uuid
           AND estado = 'OFRECIDA' AND expira_at > now()
        RETURNING donacion_id`;
      if (!aceptada) await this.motivoRespuestaFallida(tx, id, voluntario.id);

      const ok = await this.donaciones.transicion(tx, {
        donacionId: aceptada.donacion_id,
        desde: ['PUBLICADA'],
        hacia: 'ASIGNADA',
        usuarioId: usuario.id,
        datos: { asignada_at: new Date(), modo_recoleccion: 'VOLUNTARIO' },
      });
      if (!ok) {
        throw conflicto(
          'donacion-no-disponible',
          'La donación ya no está disponible',
        );
      }
      await this.trazabilidad.registrar(tx, {
        ambito: 'ASIGNACION',
        entidad: { asignacionId: id },
        anterior: 'OFRECIDA',
        nuevo: 'ACEPTADA',
        usuarioId: usuario.id,
      });
      const donacion = await this.donaciones.bloquear(tx, aceptada.donacion_id);
      await this.notificaciones.encolar(tx, {
        usuarioId: donacion!.donante_usuario_id,
        codigo: 'ASIGNACION_ACEPTADA',
        donacionId: aceptada.donacion_id,
        asignacionId: id,
        variables: { voluntario: usuario.nombres },
      });
    });
    return { id, estado: 'ACEPTADA' };
  }

  /** Rechazar cierra el intento y ofrece al siguiente EN la misma petición (§6.7). */
  async rechazar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: RespuestaConMotivoDto,
  ) {
    const voluntario = await this.voluntarios.propio(usuario.id);
    const donacionId = await this.prisma.transaccion(async (tx) => {
      const motivo = await validarMotivo(
        tx,
        dto.motivo_id,
        'RECHAZO_ASIGNACION',
        dto.observacion,
      );
      const [rechazada] = await tx.$queryRaw<{ donacion_id: string }[]>`
        UPDATE asignacion
           SET estado = 'RECHAZADA', respondida_at = now(), finalizada_at = now(),
               motivo_id = ${motivo.id}::smallint, observacion = ${dto.observacion ?? null}
         WHERE id = ${id}::uuid AND voluntario_id = ${voluntario.id}::uuid
           AND estado = 'OFRECIDA'
        RETURNING donacion_id`;
      if (!rechazada) await this.motivoRespuestaFallida(tx, id, voluntario.id);
      await this.trazabilidad.registrar(tx, {
        ambito: 'ASIGNACION',
        entidad: { asignacionId: id },
        anterior: 'OFRECIDA',
        nuevo: 'RECHAZADA',
        usuarioId: usuario.id,
        motivo: motivo.nombre,
      });
      return rechazada.donacion_id;
    });
    await this.continuarCascada(donacionId);
    return { id, estado: 'RECHAZADA' };
  }

  /**
   * Abandonar tras aceptar: la donación vuelve a PUBLICADA si la ventana deja
   * margen y la cascada se reanuda; si no, expira y se abre una incidencia.
   */
  async abandonar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: RespuestaConMotivoDto,
  ) {
    const voluntario = await this.voluntarios.propio(usuario.id);
    const { donacionId, republicada } = await this.prisma.transaccion(
      async (tx) => {
        const motivo = await validarMotivo(
          tx,
          dto.motivo_id,
          'ABANDONO_ASIGNACION',
          dto.observacion,
        );
        const [a] = await tx.$queryRaw<
          {
            donacion_id: string;
            estado: string;
            voluntario_id: string | null;
            ruta_id: string | null;
          }[]
        >`SELECT donacion_id, estado::text AS estado, voluntario_id, ruta_id
          FROM asignacion WHERE id = ${id}::uuid FOR UPDATE`;
        if (!a || a.voluntario_id !== voluntario.id)
          throw noEncontrado('Asignación');
        if (a.estado !== 'ACEPTADA') {
          throw conflicto(
            'asignacion-no-aceptada',
            'Solo se abandona una asignación aceptada',
          );
        }
        const recogida = await tx.parada_ruta.count({
          where: {
            donacion_id: a.donacion_id,
            tipo: 'RECOGIDA',
            estado: 'COMPLETADA',
          },
        });
        if (recogida) {
          throw conflicto(
            'donacion-ya-recogida',
            'Ya recogiste la donación: repórtalo como incidencia y llévala a la sede',
          );
        }

        await tx.asignacion.update({
          where: { id },
          data: {
            estado: 'ABANDONADA',
            abandonada_at: new Date(),
            finalizada_at: new Date(),
            motivo_id: motivo.id,
            observacion: dto.observacion ?? null,
          },
        });
        await this.trazabilidad.registrar(tx, {
          ambito: 'ASIGNACION',
          entidad: { asignacionId: id },
          anterior: 'ACEPTADA',
          nuevo: 'ABANDONADA',
          usuarioId: usuario.id,
          motivo: motivo.nombre,
        });
        if (a.ruta_id)
          await this.omitirParada(
            tx,
            a.ruta_id,
            a.donacion_id,
            usuario.id,
            motivo.nombre,
          );

        const republicada = await this.donaciones.reabrirPublicacion(
          tx,
          a.donacion_id,
          ['ASIGNADA', 'EN_RECOLECCION'],
          usuario.id,
          'El voluntario abandonó la asignación',
        );
        if (!republicada) {
          await this.donaciones.expirar(
            tx,
            a.donacion_id,
            ['ASIGNADA', 'EN_RECOLECCION'],
            'El voluntario abandonó y la ventana ya no permite otra recogida',
            usuario.id,
          );
          await this.incidencias.registrar(tx, {
            tipoCodigo: 'OTRO',
            nivel: 'MEDIA',
            descripcion: `Asignación abandonada sin margen para reasignar. Motivo: ${motivo.nombre}${
              dto.observacion ? ` — ${dto.observacion}` : ''
            }`,
            reportadaPor: usuario.id,
            donacion_id: a.donacion_id,
            asignacion_id: id,
          });
        }
        return { donacionId: a.donacion_id, republicada };
      },
    );
    if (republicada) await this.continuarCascada(donacionId);
    return { id, estado: 'ABANDONADA', donacion_republicada: republicada };
  }

  /** Calificación mutua, una vez por parte, tras COMPLETADA. */
  async calificar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: CalificacionDto,
  ) {
    const a = await this.prisma.asignacion.findUnique({
      where: { id },
      select: {
        estado: true,
        voluntario: { select: { id: true, usuario_id: true } },
        donacion: {
          select: { donante: { select: { id: true, usuario_id: true } } },
        },
      },
    });
    if (!a) throw noEncontrado('Asignación');
    const donante = a.donacion.donante;
    const esDonante =
      donante.usuario_id === usuario.id && tieneRol(usuario, 'DONANTE');
    const esVoluntario =
      a.voluntario?.usuario_id === usuario.id &&
      tieneRol(usuario, 'VOLUNTARIO');
    if (!esDonante && !esVoluntario) throw noEncontrado('Asignación');
    if (a.estado !== 'COMPLETADA') {
      throw conflicto(
        'asignacion-no-completada',
        'Solo se califica una recolección completada',
      );
    }
    if (!a.voluntario) {
      throw noProcesable(
        'sin-voluntario',
        'Las recolecciones de la flota del banco no se califican',
      );
    }
    const voluntario = a.voluntario;
    const calificado = esDonante ? voluntario.usuario_id : donante.usuario_id;

    try {
      return await this.prisma.transaccion(async (tx) => {
        const calificacion = await tx.calificacion.create({
          data: {
            asignacion_id: id,
            calificador_id: usuario.id,
            calificado_id: calificado,
            puntaje: dto.puntaje,
            comentario: dto.comentario ?? null,
          },
          select: {
            id: true,
            puntaje: true,
            comentario: true,
            created_at: true,
          },
        });
        if (esDonante) {
          await tx.$executeRaw`
            UPDATE voluntario v
               SET calificacion_promedio = s.promedio
              FROM (SELECT round(avg(c.puntaje), 2) AS promedio
                      FROM calificacion c
                      JOIN asignacion x ON x.id = c.asignacion_id
                     WHERE x.voluntario_id = ${voluntario.id}::uuid
                       AND c.calificado_id = ${voluntario.usuario_id}::uuid) s
             WHERE v.id = ${voluntario.id}::uuid`;
        } else {
          await tx.$executeRaw`
            UPDATE donante dn
               SET calificacion_promedio = s.promedio, total_calificaciones = s.total
              FROM (SELECT round(avg(c.puntaje), 2) AS promedio, count(*)::int AS total
                      FROM calificacion c
                      JOIN asignacion x ON x.id = c.asignacion_id
                      JOIN donacion d ON d.id = x.donacion_id
                     WHERE d.donante_id = ${donante.id}::uuid
                       AND c.calificado_id = ${donante.usuario_id}::uuid) s
             WHERE dn.id = ${donante.id}::uuid`;
        }
        return calificacion;
      });
    } catch (err) {
      if (violaUnicidad(err)) {
        throw conflicto('ya-calificada', 'Ya calificaste esta recolección');
      }
      throw err;
    }
  }
}
