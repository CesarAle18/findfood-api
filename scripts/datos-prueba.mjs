#!/usr/bin/env node
// Datos para probar la API a mano contra la base LOCAL (npm run db:local).
//
//   npm run datos:prueba
//
// 1. Crea .env.local (si no existe) para arrancar la API contra la base local
//    con un secreto JWT propio y Storage simulado: npm run start:local
// 2. Siembra cuentas (admin, asesor, donante, voluntario aprobado), el banco y
//    dos sedes. Es idempotente: se puede correr varias veces.
// 3. Escribe postman/FindFood-local.postman_environment.json con los ids de las
//    cuentas y del catálogo, y la clave local con la que la colección firma los tokens.
//
// Nunca toca la base real: se niega a correr si el host no es local.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const URL_BASE =
  process.env.PRUEBAS_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54329/findfood';
const SUPABASE_LOCAL = 'http://127.0.0.1:54321';

const host = new URL(URL_BASE).hostname;
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  console.error(`Solo se siembra una base local; ${host} no lo es.`);
  process.exit(1);
}

// --- .env.local ---------------------------------------------------------------
const archivoEnv = join(RAIZ, '.env.local');
let secreto;
if (existsSync(archivoEnv)) {
  secreto = /^SUPABASE_JWT_SECRET=(.+)$/m.exec(readFileSync(archivoEnv, 'utf8'))?.[1];
}
if (!secreto) {
  secreto = randomBytes(32).toString('hex');
  writeFileSync(
    archivoEnv,
    `# Generado por scripts/datos-prueba.mjs: API contra la base local (npm run start:local).
NODE_ENV=development
PORT=3000
LOG_LEVEL=info
DATABASE_URL=postgresql://app_backend:app_backend_local@127.0.0.1:54329/findfood
DB_POOL_MAX=5
SUPABASE_URL=${SUPABASE_LOCAL}
SUPABASE_SERVICE_ROLE_KEY=clave-local-no-valida
SUPABASE_JWT_SECRET=${secreto}
STORAGE_SIMULADO=true
TAREAS_HABILITADAS=true
CORS_ORIGENES=http://localhost:5173
`,
    { mode: 0o600 },
  );
  console.log('Creado .env.local');
}

// --- Siembra ------------------------------------------------------------------
const db = new pg.Client({ connectionString: URL_BASE });
await db.connect();

const punto = (p) => `ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326)::geography`;

async function cuenta(email, nombres, appMeta = { provider: 'email' }) {
  const previa = await db.query('SELECT id FROM auth.users WHERE email = $1', [email]);
  if (previa.rowCount) return previa.rows[0].id;
  const { rows } = await db.query(
    `INSERT INTO auth.users (email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
     VALUES ($1, 'local', now(), $2, $3) RETURNING id`,
    [email, appMeta, { nombres, telefono: '+573001234567', acepto_terminos: true }],
  );
  return rows[0].id;
}

const ids = {
  admin: await cuenta('admin@findfood.local', 'Ada Admin', { rol: 'ADMIN' }),
  asesor: await cuenta('asesor@findfood.local', 'Andrés Asesor', { rol: 'ASESOR_BANCO' }),
  donante: await cuenta('donante@findfood.local', 'Diana Donante'),
  voluntario: await cuenta('voluntario@findfood.local', 'Víctor Voluntario'),
  // Donante que solicita ser voluntario en la carpeta 8 de la colección.
  solicitante: await cuenta('solicitante@findfood.local', 'Sara Solicitante'),
};

// Voluntario ya aprobado, disponible toda la semana y con base en Chapinero.
const vol = await db.query('SELECT id FROM voluntario WHERE usuario_id = $1', [ids.voluntario]);
if (!vol.rowCount) {
  const { rows } = await db.query(
    `INSERT INTO voluntario
       (usuario_id, tipo_vehiculo_id, fecha_nacimiento, placa_vehiculo, url_foto_vehiculo,
        capacidad_carga_kg, tiene_refrigeracion, ubicacion_base, radio_cobertura_km,
        disponible, estado_verificacion, verificado_por, verificado_at)
     VALUES ($1, (SELECT id FROM tipo_vehiculo WHERE codigo = 'CAMIONETA'), '1992-03-15', 'PRU123',
             $2, 500, true, ${punto({ lat: 4.6553, lng: -74.0816 })}, 25, true, 'APROBADA', $3, now())
     RETURNING id`,
    [ids.voluntario, `documentos-identidad/${ids.voluntario}/vehiculo.jpg`, ids.admin],
  );
  await db.query(
    `INSERT INTO usuario_rol (usuario_id, rol_id)
     SELECT $1, id FROM rol WHERE codigo = 'VOLUNTARIO'
     ON CONFLICT (usuario_id, rol_id) DO UPDATE SET activo = true`,
    [ids.voluntario],
  );
  await db.query(
    `INSERT INTO voluntario_disponibilidad (voluntario_id, dia_semana, hora_inicio, hora_fin)
     SELECT $1, d, '00:00', '23:59' FROM generate_series(0, 6) d`,
    [rows[0].id],
  );
}

const banco = await db.query('SELECT id FROM banco_alimentos WHERE deleted_at IS NULL');
if (!banco.rowCount) {
  const { rows } = await db.query(
    `INSERT INTO banco_alimentos (nombre, direccion, ciudad, ubicacion, tiene_flota_propia)
     VALUES ('Banco de Alimentos (local)', 'Calle 19 # 32-50', 'Bogotá', ${punto({ lat: 4.6097, lng: -74.0817 })}, true)
     RETURNING id`,
  );
  for (const [nombre, tipo, p] of [
    ['Sede Norte (seco)', 'SECO', { lat: 4.7, lng: -74.05 }],
    ['Sede Centro (refrigerado)', 'REFRIGERADO', { lat: 4.61, lng: -74.08 }],
  ]) {
    await db.query(
      `INSERT INTO almacen (banco_id, nombre, direccion, ubicacion, tipo, capacidad_kg)
       VALUES ($1, $2, 'Carrera 7 # 10-20', ${punto(p)}, $3, 5000)`,
      [rows[0].id, nombre, tipo],
    );
  }
}

const uno = async (sql, params = []) => (await db.query(sql, params)).rows[0]?.id ?? '';
const catalogo = {
  TIPO_ARROZ: await uno(`SELECT id FROM tipo_alimento WHERE codigo = 'ARROZ'`),
  TIPO_LECHE: await uno(`SELECT id FROM tipo_alimento WHERE codigo = 'LECHE'`),
  UNIDAD_KG: await uno(`SELECT id FROM unidad_medida WHERE codigo = 'KG'`),
  MOTIVO_RECHAZO_ASIGNACION: await uno(`SELECT id FROM motivo WHERE ambito = 'RECHAZO_ASIGNACION' AND codigo = 'SIN_TIEMPO'`),
  MOTIVO_ABANDONO: await uno(`SELECT id FROM motivo WHERE ambito = 'ABANDONO_ASIGNACION' AND codigo = 'VEHICULO'`),
  MOTIVO_CANCELACION: await uno(`SELECT id FROM motivo WHERE ambito = 'CANCELACION_DONACION' AND codigo = 'CAMBIO_DE_PLANES'`),
  MOTIVO_RECHAZO_RECEPCION: await uno(`SELECT id FROM motivo WHERE ambito = 'RECHAZO_RECEPCION' AND codigo = 'SIN_CAPACIDAD'`),
  MOTIVO_RECHAZO_VERIFICACION: await uno(`SELECT id FROM motivo WHERE ambito = 'RECHAZO_VERIFICACION' AND codigo = 'DOC_ILEGIBLE'`),
  TIPO_INCIDENCIA_AUSENTE: await uno(`SELECT id FROM tipo_incidencia WHERE codigo = 'DONANTE_AUSENTE'`),
  DESTINO_COMEDOR: await uno(`SELECT id FROM tipo_destino_distribucion WHERE codigo = 'COMEDOR'`),
  VEHICULO_AUTOMOVIL: await uno(`SELECT id FROM tipo_vehiculo WHERE codigo = 'AUTOMOVIL'`),
};
await db.end();

// Sin JWT en el archivo: la colección los firma en cada petición con esta clave
// (Postman bloquea la importación de environments que contienen tokens).
const variables = {
  base_url: 'http://localhost:3000',
  clave_jwt_local: secreto,
  emisor_jwt_local: `${SUPABASE_LOCAL}/auth/v1`,
  ...Object.fromEntries(Object.entries(ids).map(([rol, id]) => [`id_${rol}`, id])),
  ...Object.fromEntries(Object.entries(catalogo).map(([k, v]) => [k.toLowerCase(), String(v)])),
};
writeFileSync(
  join(RAIZ, 'postman', 'FindFood-local.postman_environment.json'),
  `${JSON.stringify(
    {
      id: 'b2f0c9e4-6b1d-4f3a-9c2e-5f0d0f00d10c',
      name: 'FindFood local',
      values: Object.entries(variables).map(([key, value]) => ({
        key,
        value,
        type: 'default',
        enabled: true,
      })),
      _postman_variable_scope: 'environment',
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);

console.log(`Datos listos. Cuentas: ${Object.keys(ids).join(', ')} (@findfood.local).
Environment de Postman: postman/FindFood-local.postman_environment.json
Siguiente paso: npm run start:local e importar la colección y el environment en Postman.`);
