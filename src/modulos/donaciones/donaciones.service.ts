import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import {
  esPersonal,
  tieneRol,
  type UsuarioAutenticado,
} from '../../comun/auth/tipos';
import { generarCodigo } from '../../comun/codigos';
import { type Coordenada, sqlPunto } from '../../comun/geo';
import {
  conflicto,
  noEncontrado,
  noProcesable,
  prohibido,
} from '../../comun/http/problema';
import { validarMotivo } from '../../comun/motivos';
import { PrismaService, type Tx } from '../../comun/prisma/prisma.service';
import { fechaBogota, fechaSinHora } from '../../comun/tiempo';
import { TrazabilidadService } from '../../comun/trazabilidad/trazabilidad.service';
import type { Pagina } from '../../comun/validacion';
import { Prisma } from '../../generated/prisma/client';
import type { estado_donacion } from '../../generated/prisma/enums';
import { AsignacionService } from '../asignacion/asignacion.service';
import { ArchivosService } from '../evidencias/archivos.service';
import { NotificacionesService } from '../notificaciones/notificaciones.service';
import { ParametrosService } from '../parametros/parametros.service';
import type {
  ActualizarDonacionDto,
  CancelarDonacionDto,
  CrearDonacionDto,
  ItemDonacionDto,
  ListarDonacionesDto,
} from './donaciones.dto';
import { scoreUrgencia } from './urgencia';

/** Tolerancia de reloj del dispositivo para "inicio en el futuro" (§6.1). */
const TOLERANCIA_INICIO_MIN = 5;
/** Margen mínimo antes del cierre de la ventana para (re)publicar. */
export const MARGEN_PUBLICACION_MIN = 15;
const ESTADOS_EDITABLES: estado_donacion[] = ['BORRADOR', 'EXPIRADA'];

export interface DonacionBloqueada {
  id: string;
  codigo: string;
  estado: estado_donacion;
  donante_id: string;
  donante_usuario_id: string;
  ventana_recogida_inicio: Date;
  ventana_recogida_fin: Date;
  expira_publicacion_at: Date | null;
}

export interface Transicion {
  donacionId: string;
  desde: estado_donacion[];
  hacia: estado_donacion;
  datos?: Prisma.donacionUncheckedUpdateInput;
  usuarioId?: string | null;
  motivo?: string | null;
  metadata?: Record<string, unknown>;
  ubicacion?: Coordenada | null;
}

type ItemPreparado = Omit<Prisma.donacion_itemCreateManyInput, 'donacion_id'>;

@Injectable()
export class DonacionesService {
  private readonly logger = new Logger(DonacionesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trazabilidad: TrazabilidadService,
    private readonly notificaciones: NotificacionesService,
    private readonly parametros: ParametrosService,
    private readonly archivos: ArchivosService,
    @Inject(forwardRef(() => AsignacionService))
    private readonly asignacion: AsignacionService,
  ) {}

  // ===========================================================================
  // Primitivas transaccionales (las usan asignación, ruteo e inventario)
  // ===========================================================================

  async bloquear(tx: Tx, id: string): Promise<DonacionBloqueada | undefined> {
    const [fila] = await tx.$queryRaw<DonacionBloqueada[]>`
      SELECT d.id, d.codigo, d.estado::text AS estado, d.donante_id,
             dn.usuario_id AS donante_usuario_id,
             d.ventana_recogida_inicio, d.ventana_recogida_fin, d.expira_publicacion_at
        FROM donacion d
        JOIN donante dn ON dn.id = d.donante_id
       WHERE d.id = ${id}::uuid
       FOR UPDATE OF d`;
    return fila;
  }

  /**
   * Cambio de estado condicionado al estado actual, con su historial en la
   * misma transacción. Devuelve false si la donación no estaba en `desde`.
   */
  async transicion(tx: Tx, t: Transicion): Promise<boolean> {
    const actual = await this.bloquear(tx, t.donacionId);
    if (!actual || !t.desde.includes(actual.estado)) return false;
    await tx.donacion.update({
      where: { id: t.donacionId },
      data: {
        ...t.datos,
        estado: t.hacia,
        updated_by: t.usuarioId ?? undefined,
      },
    });
    await this.trazabilidad.registrar(tx, {
      ambito: 'DONACION',
      entidad: { donacionId: t.donacionId },
      anterior: actual.estado,
      nuevo: t.hacia,
      usuarioId: t.usuarioId,
      motivo: t.motivo,
      metadata: t.metadata,
      ubicacion: t.ubicacion,
    });
    return true;
  }

  /**
   * Vuelve a PUBLICADA con un plazo nuevo, acotado por el cierre de la ventana.
   * Devuelve false si la ventana ya no deja margen para otra recogida.
   */
  async reabrirPublicacion(
    tx: Tx,
    donacionId: string,
    desde: estado_donacion[],
    usuarioId: string | null,
    motivo: string,
  ): Promise<boolean> {
    const actual = await this.bloquear(tx, donacionId);
    if (!actual || !desde.includes(actual.estado)) return false;
    const timeout = await this.parametros.entero('PUBLICACION_TIMEOUT_MIN');
    const filas = await tx.$executeRaw`
      UPDATE donacion
         SET estado = 'PUBLICADA',
             publicada_at = now(),
             expira_publicacion_at = least(now() + make_interval(mins => ${timeout}::int),
                                           ventana_recogida_fin),
             asignada_at = NULL,
             updated_by = ${usuarioId}::uuid
       WHERE id = ${donacionId}::uuid
         AND ventana_recogida_fin > now() + make_interval(mins => ${MARGEN_PUBLICACION_MIN}::int)`;
    if (!filas) return false;
    await this.trazabilidad.registrar(tx, {
      ambito: 'DONACION',
      entidad: { donacionId },
      anterior: actual.estado,
      nuevo: 'PUBLICADA',
      usuarioId,
      motivo,
    });
    return true;
  }

  /** Pasa a EXPIRADA y avisa al donante (DONACION_EXPIRADA). */
  async expirar(
    tx: Tx,
    donacionId: string,
    desde: estado_donacion[],
    motivo: string,
    usuarioId: string | null = null,
  ): Promise<boolean> {
    const actual = await this.bloquear(tx, donacionId);
    if (!actual) return false;
    const ok = await this.transicion(tx, {
      donacionId,
      desde,
      hacia: 'EXPIRADA',
      usuarioId,
      motivo,
    });
    if (ok) {
      await this.notificaciones.encolar(tx, {
        usuarioId: actual.donante_usuario_id,
        codigo: 'DONACION_EXPIRADA',
        donacionId,
        variables: { codigo: actual.codigo },
      });
    }
    return ok;
  }

  /**
   * Tarea expirar_publicaciones (§7): PUBLICADA con el plazo vencido pasa a
   * EXPIRADA, se cierra su oferta viva y se avisa al donante.
   */
  async expirarPublicacionesVencidas(lote = 200): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        const vencidas = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM donacion
           WHERE estado = 'PUBLICADA' AND expira_publicacion_at <= now()
           ORDER BY expira_publicacion_at
           LIMIT ${lote}
           FOR UPDATE SKIP LOCKED`;
        for (const { id } of vencidas) {
          await this.asignacion.cerrarVigentes(tx, id, 'EXPIRADA', {
            estados: ['OFRECIDA'],
            motivo: 'Venció el plazo de la publicación',
          });
          await this.expirar(
            tx,
            id,
            ['PUBLICADA'],
            'Nadie aceptó dentro del plazo de publicación',
          );
        }
        return vencidas.length;
      },
      { maxWait: 5_000, timeout: 60_000 },
    );
  }

  // ===========================================================================
  // Casos de uso
  // ===========================================================================

  private async donanteDe(usuarioId: string): Promise<{ id: string }> {
    const donante = await this.prisma.donante.findUnique({
      where: { usuario_id: usuarioId },
      select: { id: true, activo: true, deleted_at: true },
    });
    if (!donante || !donante.activo || donante.deleted_at) {
      throw prohibido(
        'sin-perfil-donante',
        'Tu cuenta no tiene un perfil de donante activo',
      );
    }
    return { id: donante.id };
  }

  private validarVentana(inicio: Date, fin: Date): void {
    if (!(fin > inicio)) {
      throw noProcesable(
        'ventana-invalida',
        'El fin de la ventana de recogida debe ser posterior al inicio',
      );
    }
  }

  private async prepararItems(
    usuarioId: string,
    items: ItemDonacionDto[],
  ): Promise<ItemPreparado[]> {
    const tipos = await this.prisma.tipo_alimento.findMany({
      where: { id: { in: items.map((i) => i.tipo_alimento_id) }, activo: true },
      select: {
        id: true,
        unidad_medida_id: true,
        requiere_refrigeracion: true,
      },
    });
    const unidadesPedidas = items
      .map((i) => i.unidad_medida_id)
      .filter((u): u is number => u !== undefined);
    const unidades = new Set(
      (
        await this.prisma.unidad_medida.findMany({
          where: { id: { in: unidadesPedidas }, activo: true },
          select: { id: true },
        })
      ).map((u) => u.id),
    );

    const preparados: ItemPreparado[] = [];
    for (const [i, item] of items.entries()) {
      const tipo = tipos.find((t) => t.id === item.tipo_alimento_id);
      if (!tipo) {
        throw noProcesable(
          'tipo-alimento-invalido',
          `items[${i}].tipo_alimento_id no existe o está inactivo`,
        );
      }
      if (
        item.unidad_medida_id !== undefined &&
        !unidades.has(item.unidad_medida_id)
      ) {
        throw noProcesable(
          'unidad-invalida',
          `items[${i}].unidad_medida_id no existe o está inactiva`,
        );
      }
      if (item.ruta_foto) {
        await this.archivos.validar(
          item.ruta_foto,
          usuarioId,
          ['donaciones'],
          `items[${i}].ruta_foto`,
        );
      }
      preparados.push({
        tipo_alimento_id: item.tipo_alimento_id,
        unidad_medida_id: item.unidad_medida_id ?? tipo.unidad_medida_id,
        descripcion: item.descripcion ?? null,
        cantidad: item.cantidad,
        peso_estimado_kg: item.peso_estimado_kg,
        fecha_vencimiento: item.fecha_vencimiento
          ? fechaSinHora(item.fecha_vencimiento)
          : null,
        // Un tipo refrigerado nunca se declara seco (cadena de frío).
        requiere_refrigeracion:
          tipo.requiere_refrigeracion || item.requiere_refrigeracion === true,
        ruta_foto: item.ruta_foto ?? null,
        observaciones: item.observaciones ?? null,
      });
    }
    return preparados;
  }

  /** Denormalizaciones de la donación a partir de sus productos (§12.3). */
  private agregados(
    items: {
      peso_estimado_kg: unknown;
      requiere_refrigeracion?: boolean;
      fecha_vencimiento?: Date | string | null;
    }[],
  ) {
    const peso = items.reduce((s, i) => s + Number(i.peso_estimado_kg), 0);
    const fechas = items
      .map((i) => (i.fecha_vencimiento ? new Date(i.fecha_vencimiento) : null))
      .filter((f): f is Date => f !== null)
      .sort((a, b) => a.getTime() - b.getTime());
    return {
      peso_estimado_kg: Math.round(peso * 100) / 100,
      requiere_refrigeracion: items.some((i) => i.requiere_refrigeracion),
      fecha_vencimiento_min: fechas[0] ?? null,
    };
  }

  async crear(usuario: UsuarioAutenticado, dto: CrearDonacionDto) {
    const donante = await this.donanteDe(usuario.id);
    const inicio = new Date(dto.ventana_recogida_inicio);
    const fin = new Date(dto.ventana_recogida_fin);
    this.validarVentana(inicio, fin);
    const items = await this.prepararItems(usuario.id, dto.items);
    const agregados = this.agregados(items);

    const id = await this.prisma.transaccion(async (tx) => {
      const [{ id }] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO donacion
          (codigo, donante_id, titulo, descripcion, peso_estimado_kg, requiere_refrigeracion,
           fecha_vencimiento_min, ventana_recogida_inicio, ventana_recogida_fin,
           direccion_recogida, referencia_recogida, ubicacion_recogida,
           contacto_nombre, contacto_telefono, created_by)
        VALUES (
          ${generarCodigo('DON')}, ${donante.id}::uuid, ${dto.titulo ?? null}, ${dto.descripcion ?? null},
          ${agregados.peso_estimado_kg}::numeric, ${agregados.requiere_refrigeracion},
          ${agregados.fecha_vencimiento_min}::date, ${inicio}::timestamptz, ${fin}::timestamptz,
          ${dto.direccion_recogida}, ${dto.referencia_recogida ?? null},
          ${sqlPunto(dto.ubicacion_recogida)},
          ${dto.contacto_nombre ?? null}, ${dto.contacto_telefono ?? null}, ${usuario.id}::uuid)
        RETURNING id`;
      await tx.donacion_item.createMany({
        data: items.map((i) => ({ ...i, donacion_id: id })),
      });
      await this.trazabilidad.registrar(tx, {
        ambito: 'DONACION',
        entidad: { donacionId: id },
        nuevo: 'BORRADOR',
        usuarioId: usuario.id,
      });
      return id;
    });
    return this.detalle(usuario, id);
  }

  async actualizar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: ActualizarDonacionDto,
  ) {
    const donante = await this.donanteDe(usuario.id);
    const items = dto.items
      ? await this.prepararItems(usuario.id, dto.items)
      : undefined;

    await this.prisma.transaccion(async (tx) => {
      const actual = await this.bloquear(tx, id);
      if (!actual || actual.donante_id !== donante.id)
        throw noEncontrado('Donación');
      if (!ESTADOS_EDITABLES.includes(actual.estado)) {
        throw conflicto(
          'donacion-no-editable',
          'Solo se edita una donación en BORRADOR o EXPIRADA',
          `Estado actual: ${actual.estado}`,
        );
      }
      const inicio = dto.ventana_recogida_inicio
        ? new Date(dto.ventana_recogida_inicio)
        : actual.ventana_recogida_inicio;
      const fin = dto.ventana_recogida_fin
        ? new Date(dto.ventana_recogida_fin)
        : actual.ventana_recogida_fin;
      this.validarVentana(inicio, fin);

      let agregados = {};
      if (items) {
        await tx.donacion_item.deleteMany({ where: { donacion_id: id } });
        await tx.donacion_item.createMany({
          data: items.map((i) => ({ ...i, donacion_id: id })),
        });
        agregados = this.agregados(items);
      }

      await tx.donacion.update({
        where: { id },
        data: {
          ...agregados,
          ...(dto.titulo !== undefined ? { titulo: dto.titulo } : {}),
          ...(dto.descripcion !== undefined
            ? { descripcion: dto.descripcion }
            : {}),
          ...(dto.direccion_recogida !== undefined
            ? { direccion_recogida: dto.direccion_recogida }
            : {}),
          ...(dto.referencia_recogida !== undefined
            ? { referencia_recogida: dto.referencia_recogida }
            : {}),
          ...(dto.contacto_nombre !== undefined
            ? { contacto_nombre: dto.contacto_nombre }
            : {}),
          ...(dto.contacto_telefono !== undefined
            ? { contacto_telefono: dto.contacto_telefono }
            : {}),
          ventana_recogida_inicio: inicio,
          ventana_recogida_fin: fin,
          updated_by: usuario.id,
        },
      });
      if (dto.ubicacion_recogida) {
        await tx.$executeRaw`
          UPDATE donacion SET ubicacion_recogida = ${sqlPunto(dto.ubicacion_recogida)}
           WHERE id = ${id}::uuid`;
      }
    });
    return this.detalle(usuario, id);
  }

  async listar(
    usuario: UsuarioAutenticado,
    filtro: ListarDonacionesDto,
  ): Promise<Pagina<unknown>> {
    const donde: Prisma.donacionWhereInput = {
      ...(esPersonal(usuario) ? {} : { donante: { usuario_id: usuario.id } }),
      ...(filtro.estado ? { estado: filtro.estado } : {}),
      ...(filtro.almacen_id ? { almacen_destino_id: filtro.almacen_id } : {}),
      ...(filtro.desde || filtro.hasta
        ? {
            created_at: {
              ...(filtro.desde ? { gte: new Date(filtro.desde) } : {}),
              ...(filtro.hasta ? { lte: new Date(filtro.hasta) } : {}),
            },
          }
        : {}),
    };
    const [datos, total] = await Promise.all([
      this.prisma.donacion.findMany({
        where: donde,
        orderBy: { created_at: 'desc' },
        take: filtro.limite,
        skip: filtro.desplazamiento,
        select: {
          id: true,
          codigo: true,
          estado: true,
          titulo: true,
          peso_estimado_kg: true,
          peso_recibido_kg: true,
          requiere_refrigeracion: true,
          ventana_recogida_inicio: true,
          ventana_recogida_fin: true,
          direccion_recogida: true,
          score_urgencia: true,
          publicada_at: true,
          expira_publicacion_at: true,
          created_at: true,
          almacen: { select: { id: true, nombre: true } },
          _count: { select: { donacion_item: true } },
        },
      }),
      this.prisma.donacion.count({ where: donde }),
    ]);
    return {
      datos: datos.map(({ _count, almacen, ...d }) => ({
        ...d,
        almacen_destino: almacen,
        cantidad_productos: _count.donacion_item,
      })),
      total,
      limite: filtro.limite,
      desplazamiento: filtro.desplazamiento,
    };
  }

  /**
   * Detalle según quién pregunta (Ley 1581, mínimo necesario): el teléfono del
   * voluntario lo ven el donante y el personal solo tras la aceptación; el del
   * donante, el voluntario solo tras aceptar.
   */
  async detalle(usuario: UsuarioAutenticado, id: string) {
    const d = await this.prisma.donacion.findUnique({
      where: { id },
      select: {
        id: true,
        codigo: true,
        estado: true,
        modo_recoleccion: true,
        titulo: true,
        descripcion: true,
        peso_estimado_kg: true,
        peso_recogido_kg: true,
        peso_recibido_kg: true,
        requiere_refrigeracion: true,
        fecha_vencimiento_min: true,
        ventana_recogida_inicio: true,
        ventana_recogida_fin: true,
        direccion_recogida: true,
        referencia_recogida: true,
        contacto_nombre: true,
        contacto_telefono: true,
        score_urgencia: true,
        publicada_at: true,
        expira_publicacion_at: true,
        asignada_at: true,
        recogida_at: true,
        entregada_at: true,
        recibida_at: true,
        cancelada_at: true,
        observacion_cancelacion: true,
        created_at: true,
        updated_at: true,
        motivo: { select: { codigo: true, nombre: true } },
        almacen: {
          select: { id: true, nombre: true, direccion: true, tipo: true },
        },
        donante: {
          select: {
            id: true,
            usuario_id: true,
            usuario: {
              select: { nombres: true, apellidos: true, telefono: true },
            },
          },
        },
        donacion_item: {
          orderBy: { created_at: 'asc' },
          select: {
            id: true,
            descripcion: true,
            cantidad: true,
            peso_estimado_kg: true,
            peso_real_kg: true,
            fecha_vencimiento: true,
            requiere_refrigeracion: true,
            ruta_foto: true,
            observaciones: true,
            tipo_alimento: { select: { id: true, codigo: true, nombre: true } },
            unidad_medida: { select: { id: true, codigo: true, nombre: true } },
          },
        },
      },
    });
    if (!d) throw noEncontrado('Donación');

    // Relación 1:1 errónea en el esquema introspectado: se consulta asignacion.
    const asignacion = await this.prisma.asignacion.findFirst({
      where: {
        donacion_id: id,
        estado: { in: ['OFRECIDA', 'ACEPTADA', 'COMPLETADA'] },
      },
      orderBy: { intento: 'desc' },
      select: {
        id: true,
        estado: true,
        intento: true,
        expira_at: true,
        aceptada_at: true,
        ruta_id: true,
        banco_ejecutor_id: true,
        voluntario: {
          select: {
            usuario_id: true,
            placa_vehiculo: true,
            tipo_vehiculo: { select: { nombre: true } },
            usuario_voluntario_usuario_idTousuario: {
              select: { nombres: true, apellidos: true, telefono: true },
            },
          },
        },
      },
    });

    const personal = esPersonal(usuario);
    const esDueno = d.donante.usuario_id === usuario.id;
    const esVoluntario = asignacion?.voluntario?.usuario_id === usuario.id;
    if (!personal && !esDueno && !esVoluntario) throw noEncontrado('Donación');

    const aceptada = asignacion && asignacion.estado !== 'OFRECIDA';
    const [ubicacion] = await this.prisma.$queryRaw<Coordenada[]>`
      SELECT ST_Y(ubicacion_recogida::geometry) AS lat, ST_X(ubicacion_recogida::geometry) AS lng
        FROM donacion WHERE id = ${id}::uuid`;

    const {
      donante,
      donacion_item,
      almacen,
      motivo,
      contacto_nombre,
      contacto_telefono,
      ...resto
    } = d;
    const verContactoDonante =
      personal || esDueno || (esVoluntario && aceptada);
    const perfilVoluntario = asignacion?.voluntario;

    return {
      ...resto,
      ubicacion_recogida: ubicacion,
      almacen_destino: almacen,
      motivo_cancelacion: motivo,
      contacto: verContactoDonante
        ? {
            nombre:
              contacto_nombre ??
              [donante.usuario.nombres, donante.usuario.apellidos]
                .filter(Boolean)
                .join(' '),
            telefono: contacto_telefono ?? donante.usuario.telefono,
          }
        : null,
      items: await Promise.all(
        donacion_item.map(async ({ ruta_foto, ...item }) => ({
          ...item,
          foto_url: await this.archivos.urlLectura(ruta_foto, 300),
        })),
      ),
      asignacion: asignacion
        ? {
            id: asignacion.id,
            estado: asignacion.estado,
            intento: asignacion.intento,
            expira_at: asignacion.expira_at,
            aceptada_at: asignacion.aceptada_at,
            ruta_id: asignacion.ruta_id,
            flota_banco: Boolean(asignacion.banco_ejecutor_id),
            voluntario:
              perfilVoluntario &&
              (personal || (esDueno && aceptada) || esVoluntario)
                ? {
                    nombres:
                      perfilVoluntario.usuario_voluntario_usuario_idTousuario
                        .nombres,
                    apellidos:
                      perfilVoluntario.usuario_voluntario_usuario_idTousuario
                        .apellidos,
                    telefono: aceptada
                      ? perfilVoluntario.usuario_voluntario_usuario_idTousuario
                          .telefono
                      : null,
                    placa_vehiculo: aceptada
                      ? perfilVoluntario.placa_vehiculo
                      : null,
                    tipo_vehiculo: perfilVoluntario.tipo_vehiculo.nombre,
                  }
                : null,
          }
        : null,
    };
  }

  /** Trazabilidad completa: la donación, sus intentos de asignación y sus paradas. */
  async historial(usuario: UsuarioAutenticado, id: string) {
    const d = await this.prisma.donacion.findUnique({
      where: { id },
      select: { donante: { select: { usuario_id: true } } },
    });
    if (!d || (!esPersonal(usuario) && d.donante.usuario_id !== usuario.id)) {
      throw noEncontrado('Donación');
    }
    return this.prisma.$queryRaw`
      SELECT h.id, h.ambito::text AS ambito, h.estado_anterior, h.estado_nuevo, h.motivo,
             h.metadata, h.created_at, h.donacion_id, h.asignacion_id, h.parada_id,
             u.nombres AS usuario_nombres,
             ST_Y(h.ubicacion::geometry) AS lat, ST_X(h.ubicacion::geometry) AS lng
        FROM historial_estado h
        LEFT JOIN usuario u ON u.id = h.usuario_id
       WHERE h.donacion_id = ${id}::uuid
          OR h.asignacion_id IN (SELECT a.id FROM asignacion a WHERE a.donacion_id = ${id}::uuid)
          OR h.parada_id IN (SELECT p.id FROM parada_ruta p WHERE p.donacion_id = ${id}::uuid)
       ORDER BY h.created_at, h.id`;
  }

  /** Auditoría del matching: por qué se ofreció a quien se ofreció (§6.4). */
  async candidatos(id: string) {
    const existe = await this.prisma.donacion.count({ where: { id } });
    if (!existe) throw noEncontrado('Donación');
    const filas = await this.prisma.candidato_asignacion.findMany({
      where: { donacion_id: id },
      orderBy: [{ generado_at: 'desc' }, { posicion: 'asc' }],
      select: {
        posicion: true,
        score: true,
        distancia_km: true,
        cumple_capacidad: true,
        cumple_horario: true,
        cumple_refrigeracion: true,
        ofrecido: true,
        generado_at: true,
        voluntario: {
          select: {
            id: true,
            capacidad_carga_kg: true,
            total_entregas: true,
            calificacion_promedio: true,
            usuario_voluntario_usuario_idTousuario: {
              select: { nombres: true, apellidos: true },
            },
          },
        },
      },
    });
    return filas.map(({ voluntario, ...c }) => ({
      ...c,
      voluntario: {
        id: voluntario.id,
        nombres: voluntario.usuario_voluntario_usuario_idTousuario.nombres,
        apellidos: voluntario.usuario_voluntario_usuario_idTousuario.apellidos,
        capacidad_carga_kg: voluntario.capacidad_carga_kg,
        total_entregas: voluntario.total_entregas,
        calificacion_promedio: voluntario.calificacion_promedio,
      },
    }));
  }

  /**
   * POST /v1/donaciones/{id}/publicar (§6.1). La transacción fija agregados,
   * urgencia, sede y plazos; la cascada corre DESPUÉS, fuera de la transacción,
   * para no retener conexiones mientras se consulta a Google.
   */
  async publicar(usuario: UsuarioAutenticado, id: string) {
    const donante = await this.donanteDe(usuario.id);
    await this.prisma.transaccion(async (tx) => {
      const actual = await this.bloquear(tx, id);
      if (!actual || actual.donante_id !== donante.id)
        throw noEncontrado('Donación');
      if (!ESTADOS_EDITABLES.includes(actual.estado)) {
        throw conflicto(
          'donacion-no-publicable',
          'Solo se publica una donación en BORRADOR o EXPIRADA',
          `Estado actual: ${actual.estado}`,
        );
      }

      const items = await tx.donacion_item.findMany({
        where: { donacion_id: id },
        select: {
          peso_estimado_kg: true,
          requiere_refrigeracion: true,
          fecha_vencimiento: true,
        },
      });
      if (!items.length)
        throw noProcesable('sin-productos', 'La donación no tiene productos');

      const hoy = fechaSinHora(fechaBogota());
      if (items.some((i) => i.fecha_vencimiento && i.fecha_vencimiento < hoy)) {
        throw noProcesable(
          'producto-vencido',
          'Hay productos con la fecha de vencimiento cumplida',
        );
      }

      const ahora = new Date();
      if (
        actual.ventana_recogida_inicio.getTime() <
        ahora.getTime() - TOLERANCIA_INICIO_MIN * 60_000
      ) {
        throw noProcesable(
          'ventana-en-el-pasado',
          'La ventana de recogida debe iniciar en el futuro; actualiza la donación',
        );
      }
      if (
        actual.ventana_recogida_fin.getTime() <
        ahora.getTime() + MARGEN_PUBLICACION_MIN * 60_000
      ) {
        throw noProcesable(
          'ventana-muy-corta',
          `La ventana debe cerrar al menos ${MARGEN_PUBLICACION_MIN} minutos después de publicar`,
        );
      }

      const agregados = this.agregados(items);
      const score = scoreUrgencia({
        fechaVencimientoMin:
          agregados.fecha_vencimiento_min?.toISOString().slice(0, 10) ?? null,
        requiereRefrigeracion: agregados.requiere_refrigeracion,
        ventanaFin: actual.ventana_recogida_fin,
        ahora,
      });

      // §6.6: la sede activa más cercana del régimen térmico requerido.
      const regimen = agregados.requiere_refrigeracion ? 'REFRIGERADO' : 'SECO';
      const [almacen] = await tx.$queryRaw<{ id: string }[]>`
        SELECT a.id
          FROM almacen a
          JOIN banco_alimentos b ON b.id = a.banco_id
          JOIN donacion d ON d.id = ${id}::uuid
         WHERE a.activo AND b.activo AND b.deleted_at IS NULL
           AND a.tipo = ${regimen}::tipo_almacenamiento
         ORDER BY ST_Distance(a.ubicacion, d.ubicacion_recogida)
         LIMIT 1`;
      if (!almacen) {
        throw conflicto(
          'sin-almacen-disponible',
          `No hay una sede ${regimen === 'REFRIGERADO' ? 'refrigerada' : 'seca'} activa que pueda recibir la donación`,
        );
      }

      if (actual.estado === 'EXPIRADA') {
        // Nueva publicación, nuevo ranking.
        await tx.candidato_asignacion.deleteMany({
          where: { donacion_id: id },
        });
      }

      const timeout = await this.parametros.entero('PUBLICACION_TIMEOUT_MIN');
      await tx.$executeRaw`
        UPDATE donacion
           SET estado = 'PUBLICADA',
               peso_estimado_kg = ${agregados.peso_estimado_kg}::numeric,
               requiere_refrigeracion = ${agregados.requiere_refrigeracion},
               fecha_vencimiento_min = ${agregados.fecha_vencimiento_min}::date,
               score_urgencia = ${score}::numeric,
               almacen_destino_id = ${almacen.id}::uuid,
               publicada_at = now(),
               expira_publicacion_at = now() + make_interval(mins => ${timeout}::int),
               asignada_at = NULL,
               updated_by = ${usuario.id}::uuid
         WHERE id = ${id}::uuid`;
      await this.trazabilidad.registrar(tx, {
        ambito: 'DONACION',
        entidad: { donacionId: id },
        anterior: actual.estado,
        nuevo: 'PUBLICADA',
        usuarioId: usuario.id,
        metadata: { score_urgencia: score, almacen_destino_id: almacen.id },
      });
    });

    const ofertaId = await this.iniciarCascadaSegura(id);
    return {
      ...(await this.detalle(usuario, id)),
      oferta_en_curso: Boolean(ofertaId),
    };
  }

  /** La cascada nunca hace fallar la operación que la dispara: el reloj la reintenta (§7). */
  async iniciarCascadaSegura(donacionId: string): Promise<string | null> {
    try {
      return await this.asignacion.ofrecerSiguiente(donacionId);
    } catch (err) {
      this.logger.error(
        { err, donacionId },
        'No se pudo iniciar la cascada; la reintentará vencer_ofertas',
      );
      return null;
    }
  }

  /** DONANTE dueño o ADMIN. El dueño cancela antes de la recogida; el ADMIN también en recolección. */
  async cancelar(
    usuario: UsuarioAutenticado,
    id: string,
    dto: CancelarDonacionDto,
  ) {
    const admin = tieneRol(usuario, 'ADMIN');
    await this.prisma.transaccion(async (tx) => {
      const motivo = await validarMotivo(
        tx,
        dto.motivo_id,
        'CANCELACION_DONACION',
        dto.observacion,
      );
      const actual = await this.bloquear(tx, id);
      if (!actual || (!admin && actual.donante_usuario_id !== usuario.id)) {
        throw noEncontrado('Donación');
      }
      const permitidos: estado_donacion[] = [
        'BORRADOR',
        'PUBLICADA',
        'ASIGNADA',
        'EXPIRADA',
      ];
      if (admin) permitidos.push('EN_RECOLECCION');
      if (!permitidos.includes(actual.estado)) {
        throw conflicto(
          'donacion-no-cancelable',
          'La donación ya no se puede cancelar',
          `Estado actual: ${actual.estado}`,
        );
      }
      await this.asignacion.cerrarVigentes(tx, id, 'CANCELADA', {
        usuarioId: usuario.id,
        motivo: motivo.nombre,
        notificar: true,
      });
      await this.transicion(tx, {
        donacionId: id,
        desde: permitidos,
        hacia: 'CANCELADA',
        usuarioId: usuario.id,
        motivo: motivo.nombre,
        datos: {
          cancelada_at: new Date(),
          cancelada_por: usuario.id,
          motivo_cancelacion_id: motivo.id,
          observacion_cancelacion: dto.observacion ?? null,
        },
      });
    });
    return this.detalle(usuario, id);
  }

  /**
   * Personal del banco: retira la asignación vigente (o reinicia la cascada) y
   * vuelve a publicar si la ventana aún lo permite.
   */
  async reasignar(
    usuario: UsuarioAutenticado,
    id: string,
    observacion?: string,
  ) {
    await this.prisma.transaccion(async (tx) => {
      const actual = await this.bloquear(tx, id);
      if (!actual) throw noEncontrado('Donación');
      const permitidos: estado_donacion[] = [
        'PUBLICADA',
        'ASIGNADA',
        'EN_RECOLECCION',
      ];
      if (!permitidos.includes(actual.estado)) {
        throw conflicto(
          'donacion-no-reasignable',
          'Solo se reasigna una donación publicada, asignada o en recolección',
          `Estado actual: ${actual.estado}`,
        );
      }
      const recogida = await tx.parada_ruta.count({
        where: { donacion_id: id, tipo: 'RECOGIDA', estado: 'COMPLETADA' },
      });
      if (recogida) {
        throw conflicto('donacion-ya-recogida', 'La donación ya fue recogida');
      }
      const motivo =
        observacion?.trim() || 'Reasignada por el banco de alimentos';
      await this.asignacion.cerrarVigentes(tx, id, 'CANCELADA', {
        usuarioId: usuario.id,
        motivo,
        notificar: true,
      });
      const ok = await this.reabrirPublicacion(
        tx,
        id,
        permitidos,
        usuario.id,
        motivo,
      );
      if (!ok) {
        throw conflicto(
          'ventana-cerrada',
          'La ventana de recogida ya no deja margen para otra asignación',
        );
      }
      await tx.donacion.update({
        where: { id },
        data: { modo_recoleccion: 'VOLUNTARIO' },
      });
    });
    const ofertaId = await this.iniciarCascadaSegura(id);
    return {
      ...(await this.detalle(usuario, id)),
      oferta_en_curso: Boolean(ofertaId),
    };
  }
}
