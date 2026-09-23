import { Injectable } from '@nestjs/common';
import {
  esPersonal,
  tieneRol,
  type UsuarioAutenticado,
} from '../../comun/auth/tipos';
import { generarCodigo } from '../../comun/codigos';
import {
  type Coordenada,
  distanciaKm,
  minutosEstimados,
  sqlPuntoOpcional,
} from '../../comun/geo';
import { GoogleRoutesService } from '../../comun/google/google-routes.service';
import {
  conflicto,
  noEncontrado,
  noProcesable,
  prohibido,
} from '../../comun/http/problema';
import { PrismaService, type Tx } from '../../comun/prisma/prisma.service';
import {
  fechaBogota,
  fechaSinHora,
  minutosEntre,
  sumarMinutos,
} from '../../comun/tiempo';
import { TrazabilidadService } from '../../comun/trazabilidad/trazabilidad.service';
import type { Pagina } from '../../comun/validacion';
import { Prisma } from '../../generated/prisma/client';
import { AsignacionService } from '../asignacion/asignacion.service';
import { DonacionesService } from '../donaciones/donaciones.service';
import { EvidenciasService } from '../evidencias/evidencias.service';
import { VoluntarioService } from '../identidad/voluntario.service';
import { IncidenciasService } from '../incidencias/incidencias.service';
import { NotificacionesService } from '../notificaciones/notificaciones.service';
import { ParametrosService } from '../parametros/parametros.service';
import { optimizarRuta } from './optimizacion';
import type {
  ConfirmarParadaDto,
  CrearRutaDto,
  LlegadaParadaDto,
  ListarRutasDto,
  ParadaFallidaDto,
} from './ruteo.dto';

/** Minutos que toma cada recogida en sitio (carga y registro). */
const SERVICIO_MIN = 5;
/** Una ultima_ubicacion más vieja que esto no sirve como punto de partida. */
const UBICACION_RECIENTE_MIN = 30;

interface DonacionRuta extends Coordenada {
  id: string;
  codigo: string;
  estado: string;
  peso_estimado_kg: number;
  almacen_destino_id: string | null;
  ventana_recogida_inicio: Date;
  ventana_recogida_fin: Date;
  direccion_recogida: string;
  donante_usuario_id: string;
}

interface RutaBloqueada {
  id: string;
  estado: string;
  voluntario_id: string | null;
  voluntario_usuario_id: string | null;
  banco_ejecutor_id: string | null;
  iniciada_at: Date | null;
}

interface ParadaBloqueada extends RutaBloqueada {
  parada_id: string;
  ruta_id: string;
  tipo: 'RECOGIDA' | 'ENTREGA';
  parada_estado: string;
  donacion_id: string | null;
  confirmada_por: string | null;
}

@Injectable()
export class RuteoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly parametros: ParametrosService,
    private readonly google: GoogleRoutesService,
    private readonly trazabilidad: TrazabilidadService,
    private readonly notificaciones: NotificacionesService,
    private readonly voluntarios: VoluntarioService,
    private readonly donaciones: DonacionesService,
    private readonly asignacion: AsignacionService,
    private readonly evidencias: EvidenciasService,
    private readonly incidencias: IncidenciasService,
  ) {}

  // ===========================================================================
  // Creación: agrupación (§8.1) y orden de paradas (§8.2)
  // ===========================================================================

  private leerDonaciones(
    ids: string[],
    tx: Pick<Tx, '$queryRaw'> = this.prisma,
    bloquear = false,
  ) {
    const bloqueo = bloquear ? Prisma.sql`FOR UPDATE OF d` : Prisma.empty;
    return tx.$queryRaw<DonacionRuta[]>`
      SELECT d.id, d.codigo, d.estado::text AS estado,
             d.peso_estimado_kg::float8 AS peso_estimado_kg, d.almacen_destino_id,
             d.ventana_recogida_inicio, d.ventana_recogida_fin, d.direccion_recogida,
             dn.usuario_id AS donante_usuario_id,
             ST_Y(d.ubicacion_recogida::geometry) AS lat, ST_X(d.ubicacion_recogida::geometry) AS lng
        FROM donacion d JOIN donante dn ON dn.id = d.donante_id
       WHERE d.id = ANY(${ids}::uuid[])
       ${bloqueo}`;
  }

  async crear(usuario: UsuarioAutenticado, dto: CrearRutaDto) {
    const flota =
      tieneRol(usuario, 'ASESOR_BANCO') && !tieneRol(usuario, 'VOLUNTARIO');
    const maxParadas = await this.parametros.entero('MAX_PARADAS_POR_RUTA');
    if (dto.donacion_ids.length > maxParadas) {
      throw noProcesable(
        'demasiadas-paradas',
        `Una ruta agrupa como máximo ${maxParadas} recogidas`,
      );
    }
    const donaciones = await this.leerDonaciones(dto.donacion_ids);
    if (donaciones.length !== dto.donacion_ids.length)
      throw noEncontrado('Donación');

    // --- Ejecutor y punto de partida -----------------------------------------
    let voluntarioId: string | null = null;
    let bancoId: string | null = null;
    let origen: Coordenada;
    let capacidadKg = Number.POSITIVE_INFINITY;

    if (flota) {
      const [banco] = await this.prisma.$queryRaw<
        (Coordenada & { id: string; tiene_flota_propia: boolean })[]
      >`SELECT id, tiene_flota_propia,
               ST_Y(ubicacion::geometry) AS lat, ST_X(ubicacion::geometry) AS lng
          FROM banco_alimentos WHERE deleted_at IS NULL AND activo LIMIT 1`;
      if (!banco)
        throw noProcesable(
          'sin-banco',
          'No hay un banco de alimentos configurado',
        );
      if (!banco.tiene_flota_propia) {
        throw noProcesable(
          'banco-sin-flota',
          'El banco no tiene flota propia registrada',
        );
      }
      bancoId = banco.id;
      origen = dto.origen ?? banco;
      for (const d of donaciones) {
        if (!['PUBLICADA', 'EXPIRADA'].includes(d.estado)) {
          throw conflicto(
            'donacion-no-disponible',
            `La donación ${d.codigo} no está disponible para la flota del banco`,
            `Estado: ${d.estado}`,
          );
        }
      }
    } else {
      const voluntario = await this.voluntarios.propio(usuario.id);
      voluntarioId = voluntario.id;
      capacidadKg = voluntario.capacidad_carga_kg;
      const asignaciones = await this.prisma.asignacion.findMany({
        where: {
          donacion_id: { in: dto.donacion_ids },
          voluntario_id: voluntario.id,
          estado: 'ACEPTADA',
        },
        select: { donacion_id: true, ruta_id: true },
      });
      for (const d of donaciones) {
        const a = asignaciones.find((x) => x.donacion_id === d.id);
        if (!a || d.estado !== 'ASIGNADA') {
          throw conflicto(
            'asignacion-invalida',
            `No tienes una asignación aceptada y pendiente de recoger para ${d.codigo}`,
          );
        }
        if (a.ruta_id) {
          throw conflicto(
            'donacion-ya-en-ruta',
            `La donación ${d.codigo} ya está en una ruta`,
          );
        }
      }
      const [ubicacion] = await this.prisma.$queryRaw<
        {
          base_lat: number | null;
          base_lng: number | null;
          ult_lat: number | null;
          ult_lng: number | null;
          ult_at: Date | null;
        }[]
      >`SELECT ST_Y(ubicacion_base::geometry) AS base_lat, ST_X(ubicacion_base::geometry) AS base_lng,
               ST_Y(ultima_ubicacion::geometry) AS ult_lat, ST_X(ultima_ubicacion::geometry) AS ult_lng,
               ultima_ubicacion_at AS ult_at
          FROM voluntario WHERE id = ${voluntario.id}::uuid`;
      const reciente =
        ubicacion.ult_at &&
        ubicacion.ult_lat !== null &&
        minutosEntre(ubicacion.ult_at, new Date()) <= UBICACION_RECIENTE_MIN;
      origen =
        dto.origen ??
        (reciente
          ? { lat: ubicacion.ult_lat!, lng: ubicacion.ult_lng! }
          : { lat: ubicacion.base_lat!, lng: ubicacion.base_lng! });
    }

    // --- Reglas de agrupación (§8.1) -----------------------------------------
    const almacenes = new Set(donaciones.map((d) => d.almacen_destino_id));
    if (almacenes.size !== 1 || !donaciones[0].almacen_destino_id) {
      throw noProcesable(
        'destinos-distintos',
        'Todas las donaciones de una ruta deben ir a la misma sede',
      );
    }
    const ahora = new Date();
    const fechas = new Set(
      donaciones.map((d) =>
        fechaBogota(
          d.ventana_recogida_inicio > ahora ? d.ventana_recogida_inicio : ahora,
        ),
      ),
    );
    if (fechas.size !== 1) {
      throw noProcesable(
        'fechas-distintas',
        'Solo se agrupan recogidas del mismo día',
      );
    }
    const cerrada = donaciones.find((d) => d.ventana_recogida_fin <= ahora);
    if (cerrada) {
      throw noProcesable(
        'ventana-cerrada',
        `La ventana de ${cerrada.codigo} ya cerró`,
      );
    }
    const pesoTotal = donaciones.reduce((s, d) => s + d.peso_estimado_kg, 0);
    if (pesoTotal > capacidadKg) {
      throw noProcesable(
        'excede-capacidad',
        `Las donaciones suman ${pesoTotal} kg y tu vehículo admite ${capacidadKg} kg`,
      );
    }
    if (donaciones.length > 1) {
      const distanciaMax = await this.parametros.decimal(
        'DISTANCIA_MAX_AGRUPACION_KM',
      );
      const aislada = donaciones.find(
        (d) =>
          !donaciones.some(
            (o) => o.id !== d.id && distanciaKm(d, o) <= distanciaMax,
          ),
      );
      if (aislada) {
        throw noProcesable(
          'donaciones-dispersas',
          `${aislada.codigo} está a más de ${distanciaMax} km de las demás`,
        );
      }
    }

    const [almacen] = await this.prisma.$queryRaw<
      (Coordenada & { id: string; direccion: string })[]
    >`
      SELECT id, direccion, ST_Y(ubicacion::geometry) AS lat, ST_X(ubicacion::geometry) AS lng
        FROM almacen WHERE id = ${donaciones[0].almacen_destino_id}::uuid`;

    // --- Orden de paradas (fuera de transacción: puede llamar a Google) -------
    const puntos: Coordenada[] = [origen, ...donaciones, almacen];
    const matriz = await this.google.matriz(puntos, puntos, 5_000);
    const duraciones = puntos.map((a, i) =>
      puntos.map((b, j) =>
        i === j
          ? 0
          : (matriz?.[i]?.[j]?.duracionMin ??
            minutosEstimados(distanciaKm(a, b))),
      ),
    );
    const optimizada = optimizarRuta({
      duraciones,
      ventanas: donaciones.map((d) => ({
        inicioMin: minutosEntre(ahora, d.ventana_recogida_inicio),
        finMin: minutosEntre(ahora, d.ventana_recogida_fin),
      })),
      servicioMin: SERVICIO_MIN,
    });
    if (optimizada.metodo === 'INFACTIBLE') {
      throw noProcesable(
        'ruta-infactible',
        'Ningún orden permite llegar a todas las recogidas dentro de su ventana',
        'Divide la ruta o recoge primero las donaciones con la ventana más próxima a cerrar',
      );
    }
    const ordenadas = optimizada.orden.map((i) => donaciones[i - 1]);
    const recorrido = [origen, ...ordenadas, almacen];
    const trazado = await this.google.ruta(recorrido);
    const geometria = trazado
      ? Prisma.sql`ST_SetSRID(ST_LineFromEncodedPolyline(${trazado.polilinea}), 4326)`
      : Prisma.sql`ST_GeomFromText(${`LINESTRING(${recorrido.map((p) => `${p.lng} ${p.lat}`).join(', ')})`}, 4326)`;
    let distanciaTotal = 0;
    for (let i = 1; i < recorrido.length; i++)
      distanciaTotal += distanciaKm(recorrido[i - 1], recorrido[i]);

    // --- Persistencia --------------------------------------------------------
    const rutaId = await this.prisma.transaccion(async (tx) => {
      const bloqueadas = await this.leerDonaciones(dto.donacion_ids, tx, true);
      const esperado = flota ? ['PUBLICADA', 'EXPIRADA'] : ['ASIGNADA'];
      const cambiada = bloqueadas.find((d) => !esperado.includes(d.estado));
      if (cambiada) {
        throw conflicto(
          'donacion-no-disponible',
          `La donación ${cambiada.codigo} cambió de estado`,
        );
      }

      const [{ id }] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO ruta
          (codigo, voluntario_id, banco_ejecutor_id, almacen_destino_id, fecha_programada,
           distancia_total_km, duracion_estimada_min, peso_total_estimado_kg, geometria, proveedor_ruteo)
        VALUES (
          ${generarCodigo('RUT')}, ${voluntarioId}::uuid, ${bancoId}::uuid, ${almacen.id}::uuid,
          ${fechaSinHora([...fechas][0])}::date,
          ${Math.round((trazado?.distanciaKm ?? distanciaTotal) * 100) / 100}::numeric,
          ${Math.round(optimizada.totalMin)}::int, ${Math.round(pesoTotal * 100) / 100}::numeric,
          ${geometria}, ${matriz || trazado ? 'GOOGLE' : null})
        RETURNING id`;

      for (const [k, d] of ordenadas.entries()) {
        await tx.$executeRaw`
          INSERT INTO parada_ruta
            (ruta_id, orden, tipo, donacion_id, direccion, ubicacion, hora_estimada_llegada)
          SELECT ${id}::uuid, ${k + 1}::smallint, 'RECOGIDA', d.id, d.direccion_recogida,
                 d.ubicacion_recogida, ${sumarMinutos(ahora, optimizada.llegadasMin[k])}::timestamptz
            FROM donacion d WHERE d.id = ${d.id}::uuid`;
      }
      await tx.$executeRaw`
        INSERT INTO parada_ruta
          (ruta_id, orden, tipo, almacen_id, direccion, ubicacion, hora_estimada_llegada)
        SELECT ${id}::uuid, ${ordenadas.length + 1}::smallint, 'ENTREGA', a.id, a.direccion,
               a.ubicacion, ${sumarMinutos(ahora, optimizada.llegadasMin[ordenadas.length])}::timestamptz
          FROM almacen a WHERE a.id = ${almacen.id}::uuid`;

      if (voluntarioId) {
        const { count } = await tx.asignacion.updateMany({
          where: {
            donacion_id: { in: dto.donacion_ids },
            voluntario_id: voluntarioId,
            estado: 'ACEPTADA',
            ruta_id: null,
          },
          data: { ruta_id: id },
        });
        if (count !== dto.donacion_ids.length) {
          throw conflicto(
            'asignacion-invalida',
            'Una de las asignaciones cambió mientras se creaba la ruta',
          );
        }
      } else {
        for (const d of bloqueadas) {
          await this.asignacion.asignarAFlota(
            tx,
            d.id,
            bancoId!,
            id,
            usuario.id,
          );
          await this.donaciones.transicion(tx, {
            donacionId: d.id,
            desde: ['PUBLICADA', 'EXPIRADA'],
            hacia: 'ASIGNADA',
            usuarioId: usuario.id,
            motivo: 'La recoge la flota del banco',
            datos: { asignada_at: new Date(), modo_recoleccion: 'FLOTA_BANCO' },
          });
          await this.notificaciones.encolar(tx, {
            usuarioId: d.donante_usuario_id,
            codigo: 'ASIGNACION_ACEPTADA',
            donacionId: d.id,
            variables: { voluntario: 'El banco de alimentos' },
          });
        }
      }

      await this.trazabilidad.registrar(tx, {
        ambito: 'RUTA',
        entidad: { rutaId: id },
        nuevo: 'PLANIFICADA',
        usuarioId: usuario.id,
        metadata: {
          metodo: optimizada.metodo,
          proveedor: matriz || trazado ? 'GOOGLE' : 'GEODESICO',
          recogidas: ordenadas.map((d) => d.codigo),
        },
      });
      return id;
    });
    return this.detalle(usuario, rutaId);
  }

  // ===========================================================================
  // Consulta
  // ===========================================================================

  async detalle(usuario: UsuarioAutenticado, id: string) {
    const ruta = await this.prisma.ruta.findUnique({
      where: { id },
      select: {
        id: true,
        codigo: true,
        estado: true,
        fecha_programada: true,
        distancia_total_km: true,
        duracion_estimada_min: true,
        duracion_real_min: true,
        peso_total_estimado_kg: true,
        proveedor_ruteo: true,
        iniciada_at: true,
        finalizada_at: true,
        cancelada_at: true,
        created_at: true,
        banco_ejecutor_id: true,
        almacen: { select: { id: true, nombre: true, direccion: true } },
        voluntario: {
          select: {
            id: true,
            usuario_id: true,
            placa_vehiculo: true,
            usuario_voluntario_usuario_idTousuario: {
              select: { nombres: true, apellidos: true, telefono: true },
            },
          },
        },
      },
    });
    if (
      !ruta ||
      (!esPersonal(usuario) && ruta.voluntario?.usuario_id !== usuario.id)
    ) {
      throw noEncontrado('Ruta');
    }
    const paradas = await this.prisma.$queryRaw`
      SELECT p.id, p.orden, p.tipo::text AS tipo, p.estado::text AS estado,
             p.donacion_id, p.almacen_id, p.direccion,
             ST_Y(p.ubicacion::geometry) AS lat, ST_X(p.ubicacion::geometry) AS lng,
             p.hora_estimada_llegada, p.hora_real_llegada, p.peso_confirmado_kg,
             p.confirmacion_manual, p.precision_confirmacion_m, p.confirmada_at, p.observaciones,
             d.codigo AS donacion_codigo, d.estado::text AS donacion_estado,
             d.peso_estimado_kg, d.ventana_recogida_inicio, d.ventana_recogida_fin,
             d.referencia_recogida,
             coalesce(d.contacto_nombre, u.nombres) AS contacto_nombre,
             coalesce(d.contacto_telefono, u.telefono) AS contacto_telefono
        FROM parada_ruta p
        LEFT JOIN donacion d ON d.id = p.donacion_id
        LEFT JOIN donante dn ON dn.id = d.donante_id
        LEFT JOIN usuario u ON u.id = dn.usuario_id
       WHERE p.ruta_id = ${id}::uuid
       ORDER BY p.orden`;
    const [{ geometria }] = await this.prisma.$queryRaw<
      { geometria: unknown }[]
    >`
      SELECT ST_AsGeoJSON(geometria)::json AS geometria FROM ruta WHERE id = ${id}::uuid`;
    const { voluntario, almacen, banco_ejecutor_id, ...resto } = ruta;
    return {
      ...resto,
      flota_banco: Boolean(banco_ejecutor_id),
      almacen_destino: almacen,
      voluntario: voluntario
        ? {
            id: voluntario.id,
            nombres: voluntario.usuario_voluntario_usuario_idTousuario.nombres,
            apellidos:
              voluntario.usuario_voluntario_usuario_idTousuario.apellidos,
            telefono:
              voluntario.usuario_voluntario_usuario_idTousuario.telefono,
            placa_vehiculo: voluntario.placa_vehiculo,
          }
        : null,
      geometria,
      paradas,
    };
  }

  async listar(
    usuario: UsuarioAutenticado,
    filtro: ListarRutasDto,
  ): Promise<Pagina<unknown>> {
    const donde: Prisma.rutaWhereInput = {
      ...(esPersonal(usuario)
        ? {}
        : { voluntario: { usuario_id: usuario.id } }),
      ...(filtro.estado ? { estado: filtro.estado } : {}),
    };
    const [datos, total] = await Promise.all([
      this.prisma.ruta.findMany({
        where: donde,
        orderBy: [{ fecha_programada: 'desc' }, { created_at: 'desc' }],
        take: filtro.limite,
        skip: filtro.desplazamiento,
        select: {
          id: true,
          codigo: true,
          estado: true,
          fecha_programada: true,
          distancia_total_km: true,
          duracion_estimada_min: true,
          peso_total_estimado_kg: true,
          iniciada_at: true,
          finalizada_at: true,
          almacen: { select: { id: true, nombre: true } },
          _count: { select: { parada_ruta: true } },
        },
      }),
      this.prisma.ruta.count({ where: donde }),
    ]);
    return {
      datos: datos.map(({ _count, almacen, ...r }) => ({
        ...r,
        almacen_destino: almacen,
        paradas: _count.parada_ruta,
      })),
      total,
      limite: filtro.limite,
      desplazamiento: filtro.desplazamiento,
    };
  }

  // ===========================================================================
  // Ejecución
  // ===========================================================================

  private async bloquearRuta(tx: Tx, id: string): Promise<RutaBloqueada> {
    const [ruta] = await tx.$queryRaw<RutaBloqueada[]>`
      SELECT r.id, r.estado::text AS estado, r.voluntario_id, v.usuario_id AS voluntario_usuario_id,
             r.banco_ejecutor_id, r.iniciada_at
        FROM ruta r LEFT JOIN voluntario v ON v.id = r.voluntario_id
       WHERE r.id = ${id}::uuid
       FOR UPDATE OF r`;
    if (!ruta) throw noEncontrado('Ruta');
    return ruta;
  }

  private async bloquearParada(tx: Tx, id: string): Promise<ParadaBloqueada> {
    const [p] = await tx.$queryRaw<ParadaBloqueada[]>`
      SELECT p.id AS parada_id, p.ruta_id, p.tipo::text AS tipo, p.estado::text AS parada_estado,
             p.donacion_id, p.confirmada_por,
             r.id, r.estado::text AS estado, r.voluntario_id, v.usuario_id AS voluntario_usuario_id,
             r.banco_ejecutor_id, r.iniciada_at
        FROM parada_ruta p
        JOIN ruta r ON r.id = p.ruta_id
        LEFT JOIN voluntario v ON v.id = r.voluntario_id
       WHERE p.id = ${id}::uuid
       FOR UPDATE OF p, r`;
    if (!p) throw noEncontrado('Parada');
    return p;
  }

  /**
   * Quién ejecuta: el voluntario de la ruta; en rutas de la flota, el personal.
   * En la ENTREGA también puede confirmar un asesor del banco (§11).
   */
  private exigirEjecutor(
    usuario: UsuarioAutenticado,
    ruta: RutaBloqueada,
    entrega = false,
  ): void {
    if (ruta.voluntario_usuario_id && ruta.voluntario_usuario_id === usuario.id)
      return;
    if (ruta.banco_ejecutor_id && esPersonal(usuario)) return;
    if (entrega && tieneRol(usuario, 'ASESOR_BANCO')) return;
    if (!esPersonal(usuario) && ruta.voluntario_usuario_id !== usuario.id) {
      throw noEncontrado('Ruta');
    }
    throw prohibido(
      'no-ejecutor',
      'Solo quien ejecuta la ruta puede registrar este paso',
    );
  }

  async iniciar(usuario: UsuarioAutenticado, id: string) {
    await this.prisma.transaccion(async (tx) => {
      const ruta = await this.bloquearRuta(tx, id);
      this.exigirEjecutor(usuario, ruta);
      if (ruta.estado === 'EN_CURSO') return;
      if (ruta.estado !== 'PLANIFICADA') {
        throw conflicto(
          'ruta-no-iniciable',
          'La ruta ya terminó o fue cancelada',
        );
      }
      await tx.ruta.update({
        where: { id },
        data: { estado: 'EN_CURSO', iniciada_at: new Date() },
      });
      await this.trazabilidad.registrar(tx, {
        ambito: 'RUTA',
        entidad: { rutaId: id },
        anterior: 'PLANIFICADA',
        nuevo: 'EN_CURSO',
        usuarioId: usuario.id,
      });
      const recogidas = await tx.parada_ruta.findMany({
        where: { ruta_id: id, tipo: 'RECOGIDA', estado: 'PENDIENTE' },
        select: { donacion_id: true },
      });
      for (const r of recogidas) {
        await this.donaciones.transicion(tx, {
          donacionId: r.donacion_id!,
          desde: ['ASIGNADA'],
          hacia: 'EN_RECOLECCION',
          usuarioId: usuario.id,
          metadata: { ruta_id: id },
        });
      }
    });
    return this.detalle(usuario, id);
  }

  /** Idempotente: repetir la llegada devuelve la parada sin cambios (§8.4). */
  async llegada(
    usuario: UsuarioAutenticado,
    paradaId: string,
    dto: LlegadaParadaDto,
  ) {
    await this.prisma.transaccion(async (tx) => {
      const p = await this.bloquearParada(tx, paradaId);
      this.exigirEjecutor(usuario, p, p.tipo === 'ENTREGA');
      if (p.estado !== 'EN_CURSO') {
        throw conflicto(
          'ruta-no-en-curso',
          'Inicia la ruta antes de registrar llegadas',
        );
      }
      if (p.parada_estado === 'EN_SITIO' || p.parada_estado === 'COMPLETADA')
        return;
      if (p.parada_estado !== 'PENDIENTE') {
        throw conflicto(
          'parada-cerrada',
          'La parada ya fue cerrada',
          `Estado: ${p.parada_estado}`,
        );
      }
      await tx.parada_ruta.update({
        where: { id: paradaId },
        data: { estado: 'EN_SITIO', hora_real_llegada: new Date() },
      });
      await this.trazabilidad.registrar(tx, {
        ambito: 'PARADA',
        entidad: { paradaId },
        anterior: 'PENDIENTE',
        nuevo: 'EN_SITIO',
        usuarioId: usuario.id,
        ubicacion: dto.ubicacion,
      });
    });
    return this.parada(paradaId);
  }

  /**
   * Confirmación en la parada (§8.3): peso, GPS con su precisión (o confirmación
   * manual marcada), hora del dispositivo y al menos una foto ya registrada.
   * Idempotente para quien ya la confirmó; 409 si otra vía la cerró (§8.4).
   */
  async confirmar(
    usuario: UsuarioAutenticado,
    paradaId: string,
    dto: ConfirmarParadaDto,
  ) {
    const precisionMinima = await this.parametros.decimal(
      'GPS_PRECISION_MIN_M',
    );
    const sinGpsConfiable =
      !dto.ubicacion ||
      dto.precision_m === undefined ||
      dto.precision_m > precisionMinima;
    if (sinGpsConfiable && !dto.confirmacion_manual) {
      throw noProcesable(
        'precision-insuficiente',
        `La ubicación no alcanza la precisión mínima de ${precisionMinima} m; usa la confirmación manual`,
      );
    }

    await this.prisma.transaccion(async (tx) => {
      const p = await this.bloquearParada(tx, paradaId);
      this.exigirEjecutor(usuario, p, p.tipo === 'ENTREGA');
      if (p.parada_estado === 'COMPLETADA') {
        if (p.confirmada_por === usuario.id) return;
        throw conflicto(
          'parada-cerrada',
          'La parada ya fue confirmada por otra persona',
        );
      }
      if (p.estado !== 'EN_CURSO') {
        throw conflicto('ruta-no-en-curso', 'La ruta no está en curso');
      }
      if (!['PENDIENTE', 'EN_SITIO'].includes(p.parada_estado)) {
        throw conflicto(
          'parada-cerrada',
          'La parada ya fue cerrada',
          `Estado: ${p.parada_estado}`,
        );
      }
      if (!(await this.evidencias.contarDeParada(paradaId))) {
        throw noProcesable(
          'evidencia-requerida',
          'Registra al menos una foto de la parada antes de confirmar',
        );
      }

      if (p.tipo === 'RECOGIDA') {
        await this.confirmarRecogida(tx, usuario, p, dto);
      } else {
        await this.confirmarEntrega(tx, usuario, p, dto);
      }
    });
    return this.parada(paradaId);
  }

  private async marcarCompletada(
    tx: Tx,
    usuario: UsuarioAutenticado,
    p: ParadaBloqueada,
    dto: ConfirmarParadaDto,
  ) {
    await tx.$executeRaw`
      UPDATE parada_ruta
         SET estado = 'COMPLETADA',
             confirmada_at = now(),
             confirmada_por = ${usuario.id}::uuid,
             hora_real_llegada = coalesce(hora_real_llegada, now()),
             peso_confirmado_kg = ${dto.peso_confirmado_kg ?? null}::numeric,
             ubicacion_confirmacion = ${sqlPuntoOpcional(dto.ubicacion)},
             precision_confirmacion_m = ${dto.precision_m ?? null}::numeric,
             confirmacion_manual = ${Boolean(dto.confirmacion_manual)},
             observaciones = ${dto.observaciones ?? null}
       WHERE id = ${p.parada_id}::uuid`;
    await this.trazabilidad.registrar(tx, {
      ambito: 'PARADA',
      entidad: { paradaId: p.parada_id },
      anterior: p.parada_estado,
      nuevo: 'COMPLETADA',
      usuarioId: usuario.id,
      ubicacion: dto.ubicacion,
      metadata: {
        confirmada_en_dispositivo: dto.confirmada_en_dispositivo,
        precision_m: dto.precision_m ?? null,
        confirmacion_manual: Boolean(dto.confirmacion_manual),
        peso_kg: dto.peso_confirmado_kg ?? null,
      },
    });
  }

  private async confirmarRecogida(
    tx: Tx,
    usuario: UsuarioAutenticado,
    p: ParadaBloqueada,
    dto: ConfirmarParadaDto,
  ) {
    if (dto.peso_confirmado_kg === undefined || dto.peso_confirmado_kg <= 0) {
      throw noProcesable(
        'peso-requerido',
        'Indica los kilos recogidos; si no hubo nada que recoger, marca la parada como fallida',
      );
    }
    const donacionId = p.donacion_id!;
    if (dto.items?.length) {
      const propios = await tx.donacion_item.count({
        where: {
          donacion_id: donacionId,
          id: { in: dto.items.map((i) => i.item_id) },
        },
      });
      if (propios !== dto.items.length) {
        throw noProcesable(
          'item-invalido',
          'Un producto no pertenece a esta donación',
        );
      }
      for (const i of dto.items) {
        await tx.donacion_item.update({
          where: { id: i.item_id },
          data: { peso_real_kg: i.peso_real_kg },
        });
      }
    }
    await this.marcarCompletada(tx, usuario, p, dto);
    const ok = await this.donaciones.transicion(tx, {
      donacionId,
      desde: ['EN_RECOLECCION', 'ASIGNADA'],
      hacia: 'EN_TRANSITO',
      usuarioId: usuario.id,
      ubicacion: dto.ubicacion,
      datos: {
        peso_recogido_kg: dto.peso_confirmado_kg,
        recogida_at: new Date(),
      },
    });
    if (!ok)
      throw conflicto(
        'donacion-no-disponible',
        'La donación ya no está pendiente de recogida',
      );
    const donacion = await this.donaciones.bloquear(tx, donacionId);
    await this.notificaciones.encolar(tx, {
      usuarioId: donacion!.donante_usuario_id,
      codigo: 'DONACION_RECOGIDA',
      donacionId,
    });
  }

  private async confirmarEntrega(
    tx: Tx,
    usuario: UsuarioAutenticado,
    p: ParadaBloqueada,
    dto: ConfirmarParadaDto,
  ) {
    const recogidas = await tx.parada_ruta.findMany({
      where: { ruta_id: p.ruta_id, tipo: 'RECOGIDA' },
      select: { estado: true, donacion_id: true },
    });
    if (
      recogidas.some((r) => r.estado === 'PENDIENTE' || r.estado === 'EN_SITIO')
    ) {
      throw conflicto(
        'recogidas-pendientes',
        'Aún hay recogidas sin cerrar en la ruta',
      );
    }
    await this.marcarCompletada(tx, usuario, p, dto);

    const entregadas: string[] = [];
    for (const r of recogidas.filter((x) => x.estado === 'COMPLETADA')) {
      const ok = await this.donaciones.transicion(tx, {
        donacionId: r.donacion_id!,
        desde: ['EN_TRANSITO'],
        hacia: 'ENTREGADA',
        usuarioId: usuario.id,
        ubicacion: dto.ubicacion,
        datos: { entregada_at: new Date() },
      });
      if (!ok) continue;
      entregadas.push(r.donacion_id!);
      const donacion = await this.donaciones.bloquear(tx, r.donacion_id!);
      await this.notificaciones.encolar(tx, {
        usuarioId: donacion!.donante_usuario_id,
        codigo: 'DONACION_ENTREGADA',
        donacionId: r.donacion_id!,
      });
    }
    await this.asignacion.completar(tx, entregadas, usuario.id);

    const fin = new Date();
    await tx.ruta.update({
      where: { id: p.ruta_id },
      data: {
        estado: 'COMPLETADA',
        finalizada_at: fin,
        duracion_real_min: p.iniciada_at
          ? Math.round(minutosEntre(p.iniciada_at, fin))
          : null,
      },
    });
    await this.trazabilidad.registrar(tx, {
      ambito: 'RUTA',
      entidad: { rutaId: p.ruta_id },
      anterior: 'EN_CURSO',
      nuevo: 'COMPLETADA',
      usuarioId: usuario.id,
      metadata: { donaciones_entregadas: entregadas.length },
    });
  }

  /** Recogida imposible (p. ej. donante ausente): parada FALLIDA + incidencia. */
  async fallida(
    usuario: UsuarioAutenticado,
    paradaId: string,
    dto: ParadaFallidaDto,
  ) {
    await this.prisma.transaccion(async (tx) => {
      const p = await this.bloquearParada(tx, paradaId);
      this.exigirEjecutor(usuario, p);
      if (p.tipo !== 'RECOGIDA') {
        throw noProcesable(
          'parada-no-recogida',
          'Solo una recogida puede marcarse como fallida',
        );
      }
      if (p.estado !== 'EN_CURSO')
        throw conflicto('ruta-no-en-curso', 'La ruta no está en curso');
      if (!['PENDIENTE', 'EN_SITIO'].includes(p.parada_estado)) {
        throw conflicto(
          'parada-cerrada',
          'La parada ya fue cerrada',
          `Estado: ${p.parada_estado}`,
        );
      }
      await tx.parada_ruta.update({
        where: { id: paradaId },
        data: { estado: 'FALLIDA', observaciones: dto.descripcion },
      });
      await this.trazabilidad.registrar(tx, {
        ambito: 'PARADA',
        entidad: { paradaId },
        anterior: p.parada_estado,
        nuevo: 'FALLIDA',
        usuarioId: usuario.id,
        motivo: dto.descripcion,
        ubicacion: dto.ubicacion,
      });
      await this.incidencias.registrar(tx, {
        tipoId: dto.tipo_incidencia_id,
        descripcion: dto.descripcion,
        reportadaPor: usuario.id,
        parada_id: paradaId,
        donacion_id: p.donacion_id!,
        ubicacion: dto.ubicacion,
      });
    });
    return this.parada(paradaId);
  }

  /**
   * Cancela una ruta que no ha iniciado. En rutas de voluntario las asignaciones
   * siguen ACEPTADAS (se pueden reagrupar); en las de la flota, las donaciones
   * vuelven a publicarse si la ventana lo permite.
   */
  async cancelar(usuario: UsuarioAutenticado, id: string) {
    const republicar: string[] = [];
    await this.prisma.transaccion(async (tx) => {
      const ruta = await this.bloquearRuta(tx, id);
      this.exigirEjecutor(usuario, ruta);
      if (ruta.estado !== 'PLANIFICADA') {
        throw conflicto(
          'ruta-no-cancelable',
          'Solo se cancela una ruta que no ha iniciado',
        );
      }
      await tx.ruta.update({
        where: { id },
        data: { estado: 'CANCELADA', cancelada_at: new Date() },
      });
      await tx.parada_ruta.updateMany({
        where: { ruta_id: id, estado: 'PENDIENTE' },
        data: { estado: 'OMITIDA' },
      });
      await this.trazabilidad.registrar(tx, {
        ambito: 'RUTA',
        entidad: { rutaId: id },
        anterior: 'PLANIFICADA',
        nuevo: 'CANCELADA',
        usuarioId: usuario.id,
      });
      if (ruta.voluntario_id) {
        await tx.asignacion.updateMany({
          where: { ruta_id: id, estado: 'ACEPTADA' },
          data: { ruta_id: null },
        });
        return;
      }
      const flota = await tx.asignacion.findMany({
        where: { ruta_id: id, estado: 'ACEPTADA' },
        select: { donacion_id: true },
      });
      for (const { donacion_id } of flota) {
        await this.asignacion.cerrarVigentes(tx, donacion_id, 'CANCELADA', {
          usuarioId: usuario.id,
          motivo: 'Ruta de la flota cancelada',
        });
        const ok = await this.donaciones.reabrirPublicacion(
          tx,
          donacion_id,
          ['ASIGNADA'],
          usuario.id,
          'Ruta de la flota cancelada',
        );
        if (ok) republicar.push(donacion_id);
        else {
          await this.donaciones.expirar(
            tx,
            donacion_id,
            ['ASIGNADA'],
            'Ruta de la flota cancelada sin margen para otra recogida',
            usuario.id,
          );
        }
      }
    });
    for (const d of republicar) await this.donaciones.iniciarCascadaSegura(d);
    return this.detalle(usuario, id);
  }

  private async parada(id: string) {
    const [p] = await this.prisma.$queryRaw<unknown[]>`
      SELECT p.id, p.ruta_id, p.orden, p.tipo::text AS tipo, p.estado::text AS estado,
             p.donacion_id, p.almacen_id, p.direccion,
             ST_Y(p.ubicacion::geometry) AS lat, ST_X(p.ubicacion::geometry) AS lng,
             p.hora_estimada_llegada, p.hora_real_llegada, p.peso_confirmado_kg,
             p.confirmacion_manual, p.precision_confirmacion_m, p.confirmada_at, p.observaciones
        FROM parada_ruta p WHERE p.id = ${id}::uuid`;
    return p;
  }
}
