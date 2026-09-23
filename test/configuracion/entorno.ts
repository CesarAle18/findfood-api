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
delete process.env.SMTP_URL;
