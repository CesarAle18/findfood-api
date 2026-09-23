/** Operación solo en Bogotá: zona horaria única (§3.3). */
export const ZONA_HORARIA = 'America/Bogota';

const formatoFecha = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA_HORARIA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Fecha civil en Bogotá, 'YYYY-MM-DD'. */
export function fechaBogota(instante: Date = new Date()): string {
  return formatoFecha.format(instante);
}

/** Una fecha 'YYYY-MM-DD' como Date a medianoche UTC (lo que Prisma espera en @db.Date). */
export function fechaSinHora(fecha: string): Date {
  return new Date(`${fecha}T00:00:00.000Z`);
}

export function sumarMinutos(instante: Date, minutos: number): Date {
  return new Date(instante.getTime() + minutos * 60_000);
}

export function minutosEntre(desde: Date, hasta: Date): number {
  return (hasta.getTime() - desde.getTime()) / 60_000;
}

/** 'HH:MM' o 'HH:MM:SS' como Date del 1970-01-01 UTC (columnas time de Prisma). */
export function horaComoDate(hora: string): Date {
  const [h, m, s = '0'] = hora.split(':');
  return new Date(Date.UTC(1970, 0, 1, Number(h), Number(m), Number(s)));
}

export function dateComoHora(valor: Date): string {
  return valor.toISOString().slice(11, 16);
}
