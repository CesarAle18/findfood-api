import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

/** Superusuario del servidor de pruebas (scripts/db-local.sh o el servicio de CI). */
export const URL_ADMIN =
  process.env.TEST_ADMIN_DATABASE_URL ??
  'postgresql://postgres:postgres@127.0.0.1:54329/postgres';
export const BASE_PRUEBAS = process.env.TEST_DATABASE_NAME ?? 'findfood_e2e';
export const PASSWORD_APP =
  process.env.TEST_APP_BACKEND_PASSWORD ?? 'app_backend_local';

export function urlBase(
  base: string,
  usuario?: { nombre: string; clave: string },
): string {
  const url = new URL(URL_ADMIN);
  url.pathname = `/${base}`;
  if (usuario) {
    url.username = usuario.nombre;
    url.password = usuario.clave;
  }
  return url.toString();
}

/**
 * Recrea la base de pruebas desde cero: simulación de Supabase + todas las
 * migraciones de supabase/migrations/, cada una en su transacción, igual que
 * scripts/db-local.sh.
 */
export async function recrearBaseDePruebas(): Promise<void> {
  const raiz = join(__dirname, '..', '..');
  const servidor = new Client({ connectionString: URL_ADMIN });
  await servidor.connect();
  try {
    await servidor.query(
      `DROP DATABASE IF EXISTS ${BASE_PRUEBAS} WITH (FORCE)`,
    );
    await servidor.query(`CREATE DATABASE ${BASE_PRUEBAS}`);
  } finally {
    await servidor.end();
  }

  const base = new Client({ connectionString: urlBase(BASE_PRUEBAS) });
  await base.connect();
  try {
    await base.query('SET client_min_messages = warning');
    const archivos = [
      join(raiz, 'db', 'local', 'simulacion_supabase.sql'),
      ...readdirSync(join(raiz, 'supabase', 'migrations'))
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((f) => join(raiz, 'supabase', 'migrations', f)),
    ];
    for (const archivo of archivos) {
      await base.query(`BEGIN;\n${readFileSync(archivo, 'utf8')}\nCOMMIT;`);
    }
    await base.query(
      `ALTER ROLE app_backend WITH LOGIN PASSWORD '${PASSWORD_APP}'`,
    );
  } finally {
    await base.end();
  }
}
