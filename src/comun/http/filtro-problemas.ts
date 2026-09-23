import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '../../generated/prisma/client';
import { codigoPostgres } from './errores-pg';
import { Problema } from './problema';

interface CuerpoProblema {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [extension: string]: unknown;
}

const TIPO_POR_ESTADO: Record<number, [string, string]> = {
  400: ['solicitud-invalida', 'Solicitud inválida'],
  401: ['no-autenticado', 'Autenticación requerida'],
  403: ['prohibido', 'No tiene permiso para esta operación'],
  404: ['no-encontrado', 'Recurso no encontrado'],
  405: ['metodo-no-permitido', 'Método no permitido'],
  409: ['conflicto', 'Conflicto con el estado actual'],
  413: ['carga-demasiado-grande', 'La solicitud es demasiado grande'],
  422: ['no-procesable', 'La solicitud no cumple las reglas del negocio'],
  429: ['demasiadas-solicitudes', 'Demasiadas solicitudes'],
};

/** Filtro global: toda respuesta de error es application/problem+json (RFC 9457). */
@Catch()
export class FiltroProblemas implements ExceptionFilter {
  private readonly logger = new Logger(FiltroProblemas.name);

  catch(excepcion: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const respuesta = http.getResponse<Response>();
    const peticion = http.getRequest<Request>();

    const cuerpo = this.construir(excepcion);
    cuerpo.instance = peticion.originalUrl ?? peticion.url;

    if (cuerpo.status >= 500) {
      this.logger.error(
        { err: excepcion, ruta: cuerpo.instance },
        'Error no controlado',
      );
    }

    respuesta
      .status(cuerpo.status)
      .type('application/problem+json')
      .json(cuerpo);
  }

  private construir(excepcion: unknown): CuerpoProblema {
    if (excepcion instanceof Problema) {
      return {
        ...excepcion.extensiones,
        type: excepcion.tipo,
        title: excepcion.titulo,
        status: excepcion.getStatus(),
        ...(excepcion.detalle ? { detail: excepcion.detalle } : {}),
      };
    }

    if (excepcion instanceof HttpException) {
      const status = excepcion.getStatus();
      const [tipo, titulo] = TIPO_POR_ESTADO[status] ?? [
        status >= 500 ? 'error-interno' : 'error',
        excepcion.message,
      ];
      const respuesta = excepcion.getResponse();
      const mensajes =
        typeof respuesta === 'object' && respuesta && 'message' in respuesta
          ? (respuesta as { message: unknown }).message
          : undefined;
      if (status === 400 && Array.isArray(mensajes)) {
        return {
          type: 'validacion',
          title: 'Los datos enviados no son válidos',
          status,
          errores: mensajes,
        };
      }
      return {
        type: tipo,
        title: titulo,
        status,
        ...(typeof mensajes === 'string' && mensajes !== titulo
          ? { detail: mensajes }
          : {}),
      };
    }

    const desdeBase = this.desdeBaseDeDatos(excepcion);
    if (desdeBase) return desdeBase;

    return {
      type: 'error-interno',
      title: 'Error interno del servidor',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
    };
  }

  /**
   * Las restricciones del DDL (CHECK, UNIQUE, FK, disparadores) son la última
   * barrera. Si una llega a dispararse, se responde 409/422 en vez de 500.
   */
  private desdeBaseDeDatos(excepcion: unknown): CuerpoProblema | undefined {
    if (
      excepcion instanceof Prisma.PrismaClientKnownRequestError &&
      excepcion.code === 'P2025'
    ) {
      return {
        type: 'no-encontrado',
        title: 'Recurso no encontrado',
        status: 404,
      };
    }
    switch (codigoPostgres(excepcion)) {
      case '23505':
      case 'P2002':
        return {
          type: 'conflicto-unicidad',
          title: 'Ya existe un registro con esos datos',
          status: 409,
        };
      case '23503':
      case 'P2003':
        return {
          type: 'referencia-invalida',
          title: 'El registro referenciado no existe o está en uso',
          status: 422,
        };
      case '23514':
      case '23502':
        return {
          type: 'restriccion-violada',
          title: 'La operación viola una regla de integridad de los datos',
          status: 422,
        };
      case '22P02':
      case '22007':
      case '22008':
        return {
          type: 'solicitud-invalida',
          title: 'Formato de dato inválido',
          status: 400,
        };
      default:
        return undefined;
    }
  }
}
