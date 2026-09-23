// Prisma solo introspecciona (prisma db pull) y genera el cliente. Nunca migra:
// el esquema vive en supabase/migrations/ (docs/arquitectura.md §12.1).
// La introspección necesita un rol que vea los esquemas public y auth (postgres),
// no app_backend.
import { defineConfig } from 'prisma/config';

// Prisma 7 no carga .env por su cuenta.
try {
  process.loadEnvFile();
} catch {
  // Sin .env: las variables vienen del entorno (CI, Railway).
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.PRISMA_INTROSPECCION_URL ?? '',
  },
});
