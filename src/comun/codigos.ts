import { randomInt } from 'node:crypto';
import { fechaBogota } from './tiempo';

// Sin 0/O ni 1/I/L para que se puedan dictar por teléfono.
const ALFABETO = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Código legible, p. ej. DON-260922-7K3QX (≤ 20 caracteres, cabe en varchar(20)). */
export function generarCodigo(prefijo: string, instante = new Date()): string {
  const fecha = fechaBogota(instante).slice(2).replaceAll('-', '');
  let sufijo = '';
  for (let i = 0; i < 5; i++) sufijo += ALFABETO[randomInt(ALFABETO.length)];
  return `${prefijo}-${fecha}-${sufijo}`;
}
