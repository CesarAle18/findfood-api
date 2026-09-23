import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { noProcesable } from '../../comun/http/problema';
import {
  type Bucket,
  BUCKETS,
  SupabaseService,
} from '../../comun/supabase/supabase.service';

export const PROPOSITOS = [
  'EVIDENCIA',
  'PRODUCTO',
  'DOCUMENTO_IDENTIDAD',
  'VEHICULO',
] as const;
export type Proposito = (typeof PROPOSITOS)[number];

const BUCKET_POR_PROPOSITO: Record<Proposito, Bucket> = {
  EVIDENCIA: 'evidencias',
  PRODUCTO: 'donaciones',
  DOCUMENTO_IDENTIDAD: 'documentos-identidad',
  VEHICULO: 'documentos-identidad',
};

export const EXTENSIONES = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  'heic',
  'pdf',
] as const;
export type Extension = (typeof EXTENSIONES)[number];

export interface UbicacionArchivo {
  bucket: Bucket;
  ruta: string;
}

/** Validez de las URL firmadas de subida que emite Supabase. */
const VIGENCIA_SUBIDA_S = 2 * 60 * 60;

/**
 * Rutas de objetos en los buckets privados (§8.5, §13.3). La base guarda
 * `<bucket>/<usuario>/<uuid>.<ext>`: la ruta la decide la API, así se puede
 * comprobar a quién pertenece cada archivo sin consultar Storage.
 */
@Injectable()
export class ArchivosService {
  constructor(private readonly supabase: SupabaseService) {}

  async emitirSubida(
    usuarioId: string,
    proposito: Proposito,
    extension: Extension,
  ) {
    if (extension === 'pdf' && proposito !== 'DOCUMENTO_IDENTIDAD') {
      throw noProcesable(
        'extension-no-permitida',
        'Solo los documentos de identidad admiten PDF',
      );
    }
    const bucket = BUCKET_POR_PROPOSITO[proposito];
    const objeto = `${usuarioId}/${randomUUID()}.${extension}`;
    const { url, token } = await this.supabase.urlSubida(bucket, objeto);
    return {
      ruta: `${bucket}/${objeto}`,
      url_subida: url,
      token,
      expira_en_segundos: VIGENCIA_SUBIDA_S,
    };
  }

  /** Descompone la ruta y exige que esté en uno de los buckets y sea del usuario. */
  propia(
    ruta: string,
    usuarioId: string,
    buckets: readonly Bucket[],
    campo = 'ruta',
  ): UbicacionArchivo {
    const [bucket, dueno, ...resto] = ruta.split('/');
    const valido =
      (BUCKETS as readonly string[]).includes(bucket) &&
      buckets.includes(bucket as Bucket) &&
      dueno === usuarioId &&
      resto.length === 1 &&
      /^[0-9a-f-]{36}\.[a-z]{3,4}$/.test(resto[0]);
    if (!valido) {
      throw noProcesable(
        'archivo-invalido',
        `${campo} no es un archivo subido por ti con /evidencias/upload-url`,
        undefined,
        { campo },
      );
    }
    return { bucket: bucket as Bucket, ruta: `${dueno}/${resto[0]}` };
  }

  async exigirSubido(
    ubicacion: UbicacionArchivo,
    campo = 'ruta',
  ): Promise<void> {
    if (!(await this.supabase.existeObjeto(ubicacion.bucket, ubicacion.ruta))) {
      throw noProcesable(
        'archivo-no-subido',
        `El archivo de ${campo} aún no se ha subido a Storage`,
        undefined,
        { campo },
      );
    }
  }

  /** Valida propiedad y existencia de una ruta enviada por el cliente. */
  async validar(
    ruta: string,
    usuarioId: string,
    buckets: readonly Bucket[],
    campo: string,
  ): Promise<string> {
    const ubicacion = this.propia(ruta, usuarioId, buckets, campo);
    await this.exigirSubido(ubicacion, campo);
    return ruta;
  }

  /** URL firmada de lectura de corta duración (nunca se persiste). */
  async urlLectura(
    ruta: string | null | undefined,
    segundos: number,
  ): Promise<string | null> {
    if (!ruta) return null;
    const [bucket, ...resto] = ruta.split('/');
    if (!(BUCKETS as readonly string[]).includes(bucket)) return null;
    return this.supabase.urlLectura(
      bucket as Bucket,
      resto.join('/'),
      segundos,
    );
  }
}
