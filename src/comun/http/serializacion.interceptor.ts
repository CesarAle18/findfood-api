import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { map, Observable } from 'rxjs';
import { Prisma } from '../../generated/prisma/client';

/**
 * Prisma devuelve numeric como Decimal (se serializaría como texto) y los
 * identity bigint como BigInt (JSON.stringify falla). Aquí se vuelven números.
 */
export function aJson(valor: unknown): unknown {
  if (valor === null || valor === undefined) return valor;
  if (typeof valor === 'bigint') {
    return Number.isSafeInteger(Number(valor))
      ? Number(valor)
      : valor.toString();
  }
  if (Prisma.Decimal.isDecimal(valor))
    return (valor as Prisma.Decimal).toNumber();
  if (valor instanceof Date || Buffer.isBuffer(valor)) return valor;
  if (Array.isArray(valor)) return valor.map(aJson);
  if (typeof valor === 'object') {
    const salida: Record<string, unknown> = {};
    for (const [clave, v] of Object.entries(valor)) salida[clave] = aJson(v);
    return salida;
  }
  return valor;
}

@Injectable()
export class SerializacionInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map(aJson));
  }
}
