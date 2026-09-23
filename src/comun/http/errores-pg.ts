import { Prisma } from '../../generated/prisma/client';

/**
 * Con el adaptador pg, el SQLSTATE de PostgreSQL llega anidado en distintos
 * lugares según el tipo de consulta (cliente tipado o $queryRaw). Se busca en
 * profundidad para no depender de la forma exacta del error.
 */
export function codigoPostgres(error: unknown): string | undefined {
  // Los códigos propios de Prisma (P1xxx, P2xxx…) también tienen 5 caracteres:
  // se descartan para quedarse con el SQLSTATE de PostgreSQL (incluidos P0xxx).
  const esSqlstate = (c: unknown): c is string =>
    typeof c === 'string' &&
    /^[0-9A-Z]{5}$/.test(c) &&
    !/^P[1-9]\d{3}$/.test(c);
  const visitados = new Set<unknown>();
  const pendientes: { valor: unknown; profundidad: number }[] = [
    { valor: error, profundidad: 0 },
  ];
  while (pendientes.length) {
    const { valor, profundidad } = pendientes.shift()!;
    if (
      !valor ||
      typeof valor !== 'object' ||
      profundidad > 6 ||
      visitados.has(valor)
    )
      continue;
    visitados.add(valor);
    const registro = valor as Record<string, unknown>;
    for (const clave of ['originalCode', 'code']) {
      if (esSqlstate(registro[clave])) return registro[clave];
    }
    for (const hijo of Object.values(registro)) {
      pendientes.push({ valor: hijo, profundidad: profundidad + 1 });
    }
  }
  // Último recurso: el mensaje de un $queryRaw fallido trae "Code: `23505`".
  const mensaje =
    error instanceof Error ? /Code: `([0-9A-Z]{5})`/.exec(error.message) : null;
  return mensaje && esSqlstate(mensaje[1]) ? mensaje[1] : undefined;
}

function textoError(error: unknown): string {
  if (!(error instanceof Error)) return '';
  const meta =
    error instanceof Prisma.PrismaClientKnownRequestError
      ? JSON.stringify(error.meta ?? {})
      : '';
  return `${error.message} ${meta}`;
}

/** ¿Violó la restricción o el índice único indicado? (23505 / P2002) */
export function violaUnicidad(error: unknown, restriccion?: string): boolean {
  const esUnicidad =
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002') ||
    codigoPostgres(error) === '23505';
  if (!esUnicidad) return false;
  if (!restriccion) return true;
  const texto = textoError(error);
  // P2002 del cliente tipado informa los campos, no siempre el nombre.
  return texto.includes(restriccion) || !/uq_|_key|_pkey/.test(texto);
}
