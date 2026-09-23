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
 * puntaje y oferta en cascada. La invariante "nunca dos ofertas vivas" la
 * garantiza uq_asignacion_vigente: si dos procesos compiten, uno no hace nada.
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
   * Ofrece la donación al siguiente candidato. Usa el ranking guardado mientras
   * sus candidatos sigan cumpliendo los filtros duros; recalcula (con Google)
   * solo si aparecieron voluntarios factibles que el ranking no conoce.
   * Devuelve el id de la oferta creada o null.
   */
  async ofrecerSiguiente(donacionId: string): Promise<string | null> {
    const d = await this.donacion(donacionId);
    if (
      !d ||
      d.estado !== 'PUBLICADA' ||
      !d.expira_publicacion_at ||
      d.expira_publicacion_at.getTime() <= Date.now()
    ) {
      return null;
    }
    const viva = await this.prisma.asignacion.count({
      where: {
        donacion_id: donacionId,
        estado: { in: ['OFRECIDA', 'ACEPTADA'] },
      },
    });
    if (viva) return null;

    const intentados = new Set(
      (
        await this.prisma.asignacion.findMany({
          where: { donacion_id: donacionId, voluntario_id: { not: null } },
          select: { voluntario_id: true },
        })
      ).map((a) => a.voluntario_id as string),
    );
    const pasos = await this.parametros.json<number[]>(
      'RADIO_BUSQUEDA_KM_PASOS',
    );
    const guardados = await this.prisma.candidato_asignacion.findMany({
      where: { donacion_id: donacionId },
      orderBy: { posicion: 'asc' },
      select: {
        voluntario_id: true,
        ofrecido: true,
        score: true,
        distancia_km: true,
      },
    });

    let elegido:
      { voluntarioId: string; score: number; distanciaKm: number } | undefined;

    if (guardados.length) {
      const factibles = new Map(
        (await this.etapa1(donacionId, Math.max(...pasos))).map((f) => [
          f.voluntario_id,
          f,
        ]),
      );
      const minutosVentana = minutosEntre(new Date(), d.ventana_recogida_fin);
      const siguiente = guardados.find(
        (c) =>
          !c.ofrecido &&
          !intentados.has(c.voluntario_id) &&
          factibles.has(c.voluntario_id) &&
          minutosEstimados(Number(c.distancia_km)) <= minutosVentana,
      );
      if (siguiente) {
        elegido = {
          voluntarioId: siguiente.voluntario_id,
          score: Number(siguiente.score),
          distanciaKm: Number(siguiente.distancia_km),
        };
      } else {
        const conocidos = new Set(guardados.map((g) => g.voluntario_id));
        const hayNuevos = [...factibles.keys()].some(
          (v) => !intentados.has(v) && !conocidos.has(v),
        );
        if (!hayNuevos) return null;
      }
    }

    if (!elegido) {
      const ranking = await this.clasificar(d, intentados, pasos);
      if (!ranking.length) return null;
      await this.guardarRanking(donacionId, ranking);
      elegido = {
        voluntarioId: ranking[0].voluntarioId,
        score: ranking[0].score,
        distanciaKm: ranking[0].distanciaKm,
      };
    }
    return this.crearOferta(donacionId, elegido);
  }

  /** Etapas 1 y 2 más el puntaje, excluyendo a quienes ya recibieron la oferta. */
  async clasificar(
    d: DonacionMotor,
    excluir: Set<string>,
    pasos: number[],
  ): Promise<CandidatoPuntuado[]> {
    let radio = pasos[pasos.length - 1];
    let factibles: Factible[] = [];
    for (const r of pasos) {
      factibles = (await this.etapa1(d.id, r)).filter(
        (f) => !excluir.has(f.voluntario_id),
      );
      radio = r;
      if (factibles.length) break;
    }
    if (!factibles.length) return [];

    const maximo = await this.parametros.entero('MAX_CANDIDATOS_MATRIX');
    const cercanos = factibles
      .sort((a, b) => a.distancia_km - b.distancia_km)
      .slice(0, Math.max(1, maximo));
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

    const historial = await this.prisma.$queryRaw<
      { voluntario_id: string; completadas: number; aceptadas: number }[]
    >`
      SELECT voluntario_id,
             count(*) FILTER (WHERE estado = 'COMPLETADA')::int AS completadas,
             count(*) FILTER (WHERE estado IN ('COMPLETADA','ABANDONADA'))::int AS aceptadas
        FROM asignacion
       WHERE voluntario_id = ANY(${ids}::uuid[])
       GROUP BY voluntario_id`;

    const pesos = await this.parametros.pesosPuntaje();
    return puntuarCandidatos(
      cercanos.map((c, i) => {
        const tramo = matriz?.[i]?.[0];
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
   * Crea la oferta con plazo min(ahora + ASIGNACION_TIMEOUT_MIN, expira_publicacion_at)
   * (§6.7) y encola el aviso al voluntario, todo en una transacción.
   */
  private async crearOferta(
    donacionId: string,
    c: { voluntarioId: string; score: number; distanciaKm: number },
  ): Promise<string | null> {
    try {
      return await this.prisma.transaccion(async (tx) => {
        const timeout = await this.parametros.entero('ASIGNACION_TIMEOUT_MIN');
        const [oferta] = await tx.$queryRaw<
          { id: string; expira_at: Date; intento: number }[]
        >`
          INSERT INTO asignacion
            (donacion_id, voluntario_id, intento, estado, score, distancia_km, ofrecida_at, expira_at)
          SELECT d.id, ${c.voluntarioId}::uuid,
                 coalesce((SELECT max(intento) FROM asignacion WHERE donacion_id = d.id), 0) + 1,
                 'OFRECIDA', ${c.score}::numeric, ${Math.round(c.distanciaKm * 100) / 100}::numeric,
                 now(),
                 least(now() + make_interval(mins => ${timeout}::int), d.expira_publicacion_at)
            FROM donacion d
           WHERE d.id = ${donacionId}::uuid
             AND d.estado = 'PUBLICADA'
             AND d.expira_publicacion_at > now() + interval '1 minute'
          RETURNING id, expira_at, intento`;
        if (!oferta) return null;

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
        return oferta.id;
      });
    } catch (err) {
      // Otro proceso creó la oferta a la vez: se descarta sin efecto (§6.7).
      if (
        violaUnicidad(err, 'uq_asignacion_vigente') ||
        violaUnicidad(err, 'uq_asignacion_intento')
      ) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Tarea vencer_ofertas (§7): OFRECIDA vencida → EXPIRADA y oferta al siguiente;
   * además reintenta las publicadas que no tienen oferta viva.
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
                          WHERE a.donacion_id = d.id AND a.estado IN ('OFRECIDA','ACEPTADA'))
       ORDER BY d.score_urgencia DESC NULLS LAST, d.ventana_recogida_fin
       LIMIT 50`;
    let ofertas = 0;
    for (const { id } of pendientes) {
      try {
        if (await this.ofrecerSiguiente(id)) ofertas++;
      } catch (err) {
        this.logger.error(
          { err, donacionId: id },
          'Falló la cascada de una donación',
        );
      }
    }
    return { vencidas: vencidas.length, ofertas };
  }
}
