import { Injectable } from '@nestjs/common';
import { esPersonal, type UsuarioAutenticado } from '../../comun/auth/tipos';
import { sqlPuntoOpcional } from '../../comun/geo';
import {
  conflicto,
  noEncontrado,
  noProcesable,
  prohibido,
} from '../../comun/http/problema';
import { PrismaService } from '../../comun/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { tipo_evidencia } from '../../generated/prisma/enums';
import { ArchivosService } from './archivos.service';
import type {
  PadreEvidenciaDto,
  RegistrarEvidenciaDto,
} from './evidencias.dto';

type Padre =
  | { campo: 'donacion_id'; id: string }
  | { campo: 'parada_id'; id: string }
  | { campo: 'recepcion_id'; id: string }
  | { campo: 'incidencia_id'; id: string };

const PADRE_POR_TIPO: Record<tipo_evidencia, Padre['campo'][]> = {
  PUBLICACION: ['donacion_id'],
  RECOGIDA: ['parada_id'],
  ENTREGA: ['parada_id'],
  RECEPCION: ['recepcion_id'],
  INCIDENCIA: ['incidencia_id'],
};

export interface EvidenciaVista {
  id: string;
  tipo: string;
  ruta: string;
  donacion_id: string | null;
  parada_id: string | null;
  recepcion_id: string | null;
  incidencia_id: string | null;
  capturada_at: Date;
  created_at: Date;
  precision_m: Prisma.Decimal | null;
  hash_archivo: string | null;
  mime_type: string | null;
  tamano_bytes: number | null;
  subida_por: string;
  lat: number | null;
  lng: number | null;
}

const COLUMNAS = Prisma.sql`
  id, tipo::text AS tipo, url AS ruta, donacion_id, parada_id, recepcion_id, incidencia_id,
  capturada_at, created_at, precision_m, hash_archivo, mime_type, tamano_bytes, subida_por,
  ST_Y(ubicacion::geometry) AS lat, ST_X(ubicacion::geometry) AS lng`;

function padreUnico(dto: PadreEvidenciaDto): Padre {
  const presentes = (
    ['donacion_id', 'parada_id', 'recepcion_id', 'incidencia_id'] as const
  ).filter((c) => dto[c]);
  if (presentes.length !== 1) {
    throw noProcesable(
      'padre-evidencia-invalido',
      'Indica exactamente uno de donacion_id, parada_id, recepcion_id o incidencia_id',
    );
  }
  const campo = presentes[0];
  return { campo, id: dto[campo]! };
}

/** Evidencia fotográfica (§8.5): el binario va directo a Storage; aquí solo el registro. */
@Injectable()
export class EvidenciasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly archivos: ArchivosService,
  ) {}

  async registrar(usuario: UsuarioAutenticado, dto: RegistrarEvidenciaDto) {
    const padre = padreUnico(dto);
    if (!PADRE_POR_TIPO[dto.tipo].includes(padre.campo)) {
      throw noProcesable(
        'padre-evidencia-invalido',
        `Una evidencia ${dto.tipo} debe asociarse a ${PADRE_POR_TIPO[dto.tipo].join(' o ')}`,
      );
    }

    // Reenvío desde la cola sin conexión: misma respuesta, ningún efecto.
    const previa = await this.buscar(dto.id);
    if (previa) {
      if (previa.subida_por !== usuario.id) {
        throw conflicto(
          'evidencia-id-en-uso',
          'El id de la evidencia ya está en uso',
        );
      }
      return previa;
    }

    await this.autorizarPadre(usuario, padre);
    const ubicacionArchivo = this.archivos.propia(dto.ruta, usuario.id, [
      'evidencias',
      'donaciones',
    ]);
    await this.archivos.exigirSubido(ubicacionArchivo);

    await this.prisma.$executeRaw`
      INSERT INTO evidencia
        (id, tipo, url, donacion_id, parada_id, recepcion_id, incidencia_id,
         capturada_at, ubicacion, precision_m, hash_archivo, mime_type, tamano_bytes, subida_por)
      VALUES (
        ${dto.id}::uuid, ${dto.tipo}::tipo_evidencia, ${dto.ruta},
        ${dto.donacion_id ?? null}::uuid, ${dto.parada_id ?? null}::uuid,
        ${dto.recepcion_id ?? null}::uuid, ${dto.incidencia_id ?? null}::uuid,
        ${new Date(dto.capturada_at)}::timestamptz, ${sqlPuntoOpcional(dto.ubicacion)},
        ${dto.precision_m ?? null}::numeric, ${dto.hash_archivo ?? null},
        ${dto.mime_type ?? null}, ${dto.tamano_bytes ?? null}::int, ${usuario.id}::uuid)
      ON CONFLICT (id) DO NOTHING`;

    const creada = await this.buscar(dto.id);
    if (!creada || creada.subida_por !== usuario.id) {
      throw conflicto(
        'evidencia-id-en-uso',
        'El id de la evidencia ya está en uso',
      );
    }
    return creada;
  }

  async listar(usuario: UsuarioAutenticado, filtro: PadreEvidenciaDto) {
    const padre = padreUnico(filtro);
    await this.autorizarPadre(usuario, padre, true);
    const columna = Prisma.raw(padre.campo);
    const filas = await this.prisma.$queryRaw<EvidenciaVista[]>`
      SELECT ${COLUMNAS} FROM evidencia
       WHERE ${columna} = ${padre.id}::uuid
       ORDER BY capturada_at`;
    return Promise.all(
      filas.map(async (f) => ({
        ...f,
        url_lectura: await this.archivos.urlLectura(f.ruta, 300),
      })),
    );
  }

  /** Cuántas evidencias tiene una parada (confirmar exige foto, §8.3). */
  contarDeParada(paradaId: string): Promise<number> {
    return this.prisma.evidencia.count({ where: { parada_id: paradaId } });
  }

  private async buscar(id: string): Promise<EvidenciaVista | undefined> {
    const [fila] = await this.prisma.$queryRaw<EvidenciaVista[]>`
      SELECT ${COLUMNAS} FROM evidencia WHERE id = ${id}::uuid`;
    return fila;
  }

  private async autorizarPadre(
    usuario: UsuarioAutenticado,
    padre: Padre,
    lectura = false,
  ): Promise<void> {
    const personal = esPersonal(usuario);
    switch (padre.campo) {
      case 'donacion_id': {
        const d = await this.prisma.donacion.findUnique({
          where: { id: padre.id },
          select: { donante: { select: { usuario_id: true } } },
        });
        if (!d) throw noEncontrado('Donación');
        if (personal || d.donante.usuario_id === usuario.id) return;
        if (lectura) {
          const asignado = await this.prisma.asignacion.count({
            where: {
              donacion_id: padre.id,
              estado: { in: ['ACEPTADA', 'COMPLETADA'] },
              voluntario: { usuario_id: usuario.id },
            },
          });
          if (asignado) return;
        }
        break;
      }
      case 'parada_id': {
        const p = await this.prisma.parada_ruta.findUnique({
          where: { id: padre.id },
          select: {
            ruta: { select: { voluntario: { select: { usuario_id: true } } } },
          },
        });
        if (!p) throw noEncontrado('Parada');
        if (personal || p.ruta.voluntario?.usuario_id === usuario.id) return;
        break;
      }
      case 'recepcion_id': {
        const r = await this.prisma.recepcion_donacion.count({
          where: { id: padre.id },
        });
        if (!r) throw noEncontrado('Recepción');
        if (personal) return;
        break;
      }
      case 'incidencia_id': {
        const i = await this.prisma.incidencia.findUnique({
          where: { id: padre.id },
          select: { reportada_por: true },
        });
        if (!i) throw noEncontrado('Incidencia');
        if (personal || i.reportada_por === usuario.id) return;
        break;
      }
    }
    throw prohibido(
      'evidencia-ajena',
      'No participas en el registro al que pertenece la evidencia',
    );
  }
}
