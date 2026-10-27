import { performance } from 'node:perf_hooks';
import { Injectable, Logger } from '@nestjs/common';
import { type Coordenada, minutosEstimados } from '../../comun/geo';
import { GoogleRoutesService } from '../../comun/google/google-routes.service';
import { violaUnicidad } from '../../comun/http/errores-pg';
import { PrismaService } from '../../comun/prisma/prisma.service';
import { minutosEntre } from '../../comun/tiempo';
import { TrazabilidadService } from '../../comun/trazabilidad/trazabilidad.service';
import { NotificacionesService } from '../notificaciones/notificaciones.service';
import { ParametrosService } from '../parametros/parametros.service';
import { type CandidatoPuntuado, puntuarCandidatos } from './puntaje';

interface DonacionMotor {
  id: string;
  estado: string;
  peso_estimado_kg: number;
  ventana_recogida_fin: Date;
  expira_publicacion_at: Date | null;
  lat: number;
  lng: number;
}

interface Factible {
  voluntario_id: string;
  usuario_id: string;
  distancia_km: number;
  capacidad_carga_kg: number;
}

/**
 * Motor de asignación (§6): etapa 1 (filtros duros en fn_candidatos_donacion),
 * etapa 2 (Route Matrix sobre los más cercanos, con fallback geodésico),
 * puntaje y oferta simultánea a todos los voluntarios factibles. El primero en
 * aceptar se queda la donación (uq_asignacion_aceptada) y las demás ofertas se
 * cierran; uq_asignacion_ofrecida evita ofertas duplicadas al mismo voluntario.
 */
@Injectable()
export class MotorAsignacionService {
  private readonly logger = new Logger(MotorAsignacionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly parametros: ParametrosService,
    private readonly google: GoogleRoutesService,
    private readonly trazabilidad: TrazabilidadService,
    private readonly notificaciones: NotificacionesService,
  ) {}

  /** Etapa 1. Su latencia es la del criterio P95 ≤ 500 ms (§3.2). */
  async etapa1(donacionId: string, radioKm: number): Promise<Factible[]> {
    const inicio = performance.now();
    const filas = await this.prisma.$queryRaw<Factible[]>`
      SELECT voluntario_id, usuario_id,
             distancia_km::float8 AS distancia_km,
             capacidad_carga_kg::float8 AS capacidad_carga_kg
        FROM fn_candidatos_donacion(${donacionId}::uuid, ${radioKm}::numeric)`;
    this.logger.debug(
      {
        donacionId,
        radioKm,
        candidatos: filas.length,
        ms: Math.round(performance.now() - inicio),
      },
      'etapa1 fn_candidatos_donacion',
    );
    return filas;
  }

  private async donacion(id: string): Promise<DonacionMotor | undefined> {
    const [d] = await this.prisma.$queryRaw<DonacionMotor[]>`
      SELECT id, estado::text AS estado, peso_estimado_kg::float8 AS peso_estimado_kg,
             ventana_recogida_fin, expira_publicacion_at,
             ST_Y(ubicacion_recogida::geometry) AS lat, ST_X(ubicacion_recogida::geometry) AS lng
        FROM donacion WHERE id = ${id}::uuid`;
    return d;
  }

  /**
   * Ofrece la donación, al mismo tiempo, a todos los voluntarios factibles que
   * aún no la han recibido. Es idempotente: se puede llamar de nuevo para
   * alcanzar a quienes entren a su franja o enciendan su disponibilidad.
   * Devuelve la cantidad de ofertas nuevas.
   */
  async ofrecer(donacionId: string): Promise<number> {
    const d = await this.donacion(donacionId);
    if (
      !d ||
      d.estado !== 'PUBLICADA' ||
      !d.expira_publicacion_at ||
      d.expira_publicacion_at.getTime() <= Date.now()
    ) {
      return 0;
    }
    const aceptada = await this.prisma.asignacion.count({
      where: { donacion_id: donacionId, estado: 'ACEPTADA' },
    });
    if (aceptada) return 0;

    // No se re-ofrece a quien la tiene viva, la rechazó o la abandonó.
    const excluidos = new Set(
      (
        await this.prisma.asignacion.findMany({
          where: {
            donacion_id: donacionId,
            voluntario_id: { not: null },
            OR: [
              { estado: { in: ['OFRECIDA', 'RECHAZADA', 'ABANDONADA'] } },
              { aceptada_at: { not: null } },
            ],
          },
          select: { voluntario_id: true },
        })
      ).map((a) => a.voluntario_id as string),
    );
    const pasos = await this.parametros.json<number[]>(
      'RADIO_BUSQUEDA_KM_PASOS',
    );
    const radio = Math.max(...pasos);
    const minutosVentana = minutosEntre(new Date(), d.ventana_recogida_fin);
    const factibles = (await this.etapa1(donacionId, radio)).filter(
      (f) =>
        !excluidos.has(f.voluntario_id) &&
        minutosEstimados(f.distancia_km) <= minutosVentana,
    );
    if (!factibles.length) return 0;

    const ranking = await this.clasificar(d, factibles, radio);
    await this.guardarRanking(donacionId, ranking);
    return this.crearOfertas(donacionId, ranking);
  }

  /** Etapa 2 y puntaje sobre los voluntarios que superaron la etapa 1. */
  async clasificar(
    d: DonacionMotor,
    factibles: Factible[],
    radio: number,
  ): Promise<CandidatoPuntuado[]> {
    const ordenados = [...factibles].sort(
      (a, b) => a.distancia_km - b.distancia_km,
    );
    const maximo = await this.parametros.entero('MAX_CANDIDATOS_MATRIX');
    // Google solo para los más cercanos; el resto usa la distancia geodésica.
    const cercanos = ordenados.slice(0, Math.max(1, maximo));
    const ids = cercanos.map((c) => c.voluntario_id);

    const coordenadas = await this.prisma.$queryRaw<
      (Coordenada & { id: string })[]
    >`
      SELECT id, ST_Y(ubicacion_base::geometry) AS lat, ST_X(ubicacion_base::geometry) AS lng
        FROM voluntario WHERE id = ANY(${ids}::uuid[])`;
    const origenes = ids.map((id) => coordenadas.find((c) => c.id === id)!);

    // Con un solo candidato no se llama a Google (§6.3).
    const matriz =
      cercanos.length > 1
        ? await this.google.matriz(origenes, [{ lat: d.lat, lng: d.lng }])
        : null;

    const todosIds = ordenados.map((c) => c.voluntario_id);
    const historial = await this.prisma.$queryRaw<
      { voluntario_id: string; completadas: number; aceptadas: number }[]
    >`
      SELECT voluntario_id,
             count(*) FILTER (WHERE estado = 'COMPLETADA')::int AS completadas,
             count(*) FILTER (WHERE estado IN ('COMPLETADA','ABANDONADA'))::int AS aceptadas
        FROM asignacion
       WHERE voluntario_id = ANY(${todosIds}::uuid[])
       GROUP BY voluntario_id`;

    const pesos = await this.parametros.pesosPuntaje();
    return puntuarCandidatos(
      ordenados.map((c, i) => {
        const tramo = i < cercanos.length ? matriz?.[i]?.[0] : undefined;
        const h = historial.find((x) => x.voluntario_id === c.voluntario_id);
        return {
          voluntarioId: c.voluntario_id,
          distanciaKm: tramo?.distanciaKm ?? c.distancia_km,
          etaMin: tramo?.duracionMin ?? minutosEstimados(c.distancia_km),
          capacidadKg: c.capacidad_carga_kg,
          completadas: h?.completadas ?? 0,
          aceptadas: h?.aceptadas ?? 0,
        };
      }),
      {
        pesoDonacionKg: d.peso_estimado_kg,
        minutosHastaFinVentana: minutosEntre(
          new Date(),
          d.ventana_recogida_fin,
        ),
        radioKm: radio,
        pesos,
      },
    );
  }

  /** candidato_asignacion: explica por qué se ofreció a quien se ofreció. */
  private async guardarRanking(
    donacionId: string,
    ranking: CandidatoPuntuado[],
  ): Promise<void> {
    await this.prisma.transaccion(async (tx) => {
      await tx.candidato_asignacion.deleteMany({
        where: { donacion_id: donacionId, ofrecido: false },
      });
      const { _max } = await tx.candidato_asignacion.aggregate({
        where: { donacion_id: donacionId },
        _max: { posicion: true },
      });
      const base = _max.posicion ?? 0;
      await tx.candidato_asignacion.createMany({
        skipDuplicates: true,
        data: ranking.map((c, i) => ({
          donacion_id: donacionId,
          voluntario_id: c.voluntarioId,
          posicion: base + i + 1,
          score: c.score,
          distancia_km: Math.round(c.distanciaKm * 100) / 100,
          // Todos superaron la etapa 1: cumplen los filtros duros.
          cumple_capacidad: true,
          cumple_horario: true,
          cumple_refrigeracion: true,
        })),
      });
    });
  }

  /**
   * Crea una oferta por candidato, todas con plazo expira_publicacion_at, y
   * encola el aviso a cada voluntario, en una transacción. Bloquea la donación
   * para serializar con otros procesos de oferta y con las aceptaciones.
   */
  private async crearOfertas(
    donacionId: string,
    candidatos: CandidatoPuntuado[],
  ): Promise<number> {
    try {
      return await this.prisma.transaccion(async (tx) => {
        const [d] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM donacion
           WHERE id = ${donacionId}::uuid
             AND estado = 'PUBLICADA'
             AND expira_publicacion_at > now() + interval '1 minute'
             AND NOT EXISTS (SELECT 1 FROM asignacion
                              WHERE donacion_id = ${donacionId}::uuid AND estado = 'ACEPTADA')
           FOR UPDATE`;
        if (!d) return 0;

        let creadas = 0;
        for (const c of candidatos) {
          const [oferta] = await tx.$queryRaw<
            { id: string; expira_at: Date; intento: number }[]
          >`
            INSERT INTO asignacion
              (donacion_id, voluntario_id, intento, estado, score, distancia_km, ofrecida_at, expira_at)
            SELECT d.id, ${c.voluntarioId}::uuid,
                   coalesce((SELECT max(intento) FROM asignacion WHERE donacion_id = d.id), 0) + 1,
                   'OFRECIDA', ${c.score}::numeric, ${Math.round(c.distanciaKm * 100) / 100}::numeric,
                   now(), d.expira_publicacion_at
              FROM donacion d
             WHERE d.id = ${donacionId}::uuid
            ON CONFLICT (donacion_id, voluntario_id) WHERE estado = 'OFRECIDA' DO NOTHING
            RETURNING id, expira_at, intento`;
          if (!oferta) continue;
          creadas++;

          await tx.candidato_asignacion.updateMany({
            where: { donacion_id: donacionId, voluntario_id: c.voluntarioId },
            data: { ofrecido: true },
          });
          await this.trazabilidad.registrar(tx, {
            ambito: 'ASIGNACION',
            entidad: { asignacionId: oferta.id },
            nuevo: 'OFRECIDA',
            metadata: {
              intento: oferta.intento,
              score: c.score,
              distancia_km: c.distanciaKm,
            },
          });
          const voluntario = await tx.voluntario.findUniqueOrThrow({
            where: { id: c.voluntarioId },
            select: { usuario_id: true },
          });
          await this.notificaciones.encolar(tx, {
            usuarioId: voluntario.usuario_id,
            codigo: 'ASIGNACION_OFRECIDA',
            donacionId,
            asignacionId: oferta.id,
            variables: {
              minutos: Math.max(
                1,
                Math.round(minutosEntre(new Date(), oferta.expira_at)),
              ),
            },
            data: { expira_at: oferta.expira_at.toISOString() },
          });
        }
        return creadas;
      });
    } catch (err) {
      // Otro proceso creó las mismas ofertas a la vez: se descarta sin efecto.
      if (
        violaUnicidad(err, 'uq_asignacion_ofrecida') ||
        violaUnicidad(err, 'uq_asignacion_intento')
      ) {
        return 0;
      }
      throw err;
    }
  }

  /**
   * Tarea vencer_ofertas (§7): OFRECIDA vencida → EXPIRADA; además reofrece las
   * publicadas sin aceptar, para alcanzar a voluntarios que se hayan habilitado.
   */
  async vencerOfertas(
    lote = 200,
  ): Promise<{ vencidas: number; ofertas: number }> {
    const vencidas = await this.prisma.$transaction(async (tx) => {
      const filas = await tx.$queryRaw<{ id: string; donacion_id: string }[]>`
        UPDATE asignacion a
           SET estado = 'EXPIRADA', finalizada_at = now()
         WHERE a.id IN (SELECT id FROM asignacion
                         WHERE estado = 'OFRECIDA' AND expira_at <= now()
                         ORDER BY expira_at
                         LIMIT ${lote}
                         FOR UPDATE SKIP LOCKED)
        RETURNING a.id, a.donacion_id`;
      for (const f of filas) {
        await this.trazabilidad.registrar(tx, {
          ambito: 'ASIGNACION',
          entidad: { asignacionId: f.id },
          anterior: 'OFRECIDA',
          nuevo: 'EXPIRADA',
          motivo: 'Sin respuesta dentro del plazo',
        });
      }
      return filas;
    });

    // Las más urgentes primero (ix_donacion_abiertas).
    const pendientes = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT d.id FROM donacion d
       WHERE d.estado = 'PUBLICADA'
         AND d.expira_publicacion_at > now() + interval '1 minute'
         AND NOT EXISTS (SELECT 1 FROM asignacion a
                          WHERE a.donacion_id = d.id AND a.estado = 'ACEPTADA')
       ORDER BY d.score_urgencia DESC NULLS LAST, d.ventana_recogida_fin
       LIMIT 50`;
    let ofertas = 0;
    for (const { id } of pendientes) {
      try {
        ofertas += await this.ofrecer(id);
      } catch (err) {
        this.logger.error(
          { err, donacionId: id },
          'Falló la oferta de una donación',
        );
      }
    }
    return { vencidas: vencidas.length, ofertas };
  }
}
