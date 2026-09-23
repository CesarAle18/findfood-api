import { HttpException } from '@nestjs/common';

/**
 * Error de negocio que el filtro global convierte en application/problem+json
 * (RFC 9457). `tipo` es estable: la app lo usa para mostrar el mensaje preciso.
 */
export class Problema extends HttpException {
  constructor(
    status: number,
    readonly tipo: string,
    readonly titulo: string,
    readonly detalle?: string,
    readonly extensiones?: Record<string, unknown>,
  ) {
    super(detalle ?? titulo, status);
  }
}

export const noEncontrado = (recurso: string): Problema =>
  new Problema(404, 'no-encontrado', `${recurso} no encontrado`);

export const prohibido = (tipo: string, titulo: string): Problema =>
  new Problema(403, tipo, titulo);

export const conflicto = (
  tipo: string,
  titulo: string,
  detalle?: string,
  extensiones?: Record<string, unknown>,
): Problema => new Problema(409, tipo, titulo, detalle, extensiones);

export const noProcesable = (
  tipo: string,
  titulo: string,
  detalle?: string,
  extensiones?: Record<string, unknown>,
): Problema => new Problema(422, tipo, titulo, detalle, extensiones);
