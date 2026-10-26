import { BASE_PRUEBAS, PASSWORD_APP, urlBase } from './base-de-pruebas';

// La API se conecta como app_backend, igual que en producción: las pruebas
// verifican también los privilegios del DDL (sin DELETE, sin acceso a auth).
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL = urlBase(BASE_PRUEBAS, {
  nombre: 'app_backend',
  clave: PASSWORD_APP,
});
process.env.DB_POOL_MAX = '5';
process.env.SUPABASE_URL = 'http://supabase.prueba';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'clave-de-servicio-de-pruebas';
process.env.SUPABASE_JWT_SECRET = 'secreto-de-pruebas-findfood-e2e';
process.env.TAREAS_HABILITADAS = 'false';
delete process.env.GOOGLE_MAPS_API_KEY;
// Cada suite vive en una ciudad distinta para no competir con las demás
// (escenario.ts): la zona de servicio se amplía a toda Colombia. La suite
// zona-servicio la vuelve a la de Bogotá. Este archivo corre antes de cada
// suite, así que ningún cambio pasa de una a otra.
process.env.ZONA_SERVICIO = '-4.3,-79.1,13.5,-66.8';
delete process.env.BREVO_API_KEY;
