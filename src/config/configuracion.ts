import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

const booleano = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const esquema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    // Conexión como app_backend por Supavisor en modo sesión (§12.2).
    DATABASE_URL: z.string().startsWith('postgres'),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),

    SUPABASE_URL: z.url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
    // Solo si el proyecto aún firma los JWT con el secreto HS256 heredado.
    SUPABASE_JWT_SECRET: z.string().min(16).optional(),

    GOOGLE_MAPS_API_KEY: z.string().min(1).optional(),
    EXPO_ACCESS_TOKEN: z.string().min(1).optional(),

    // Correo de la contraseña temporal de los asesores. Sin SMTP, la API la
    // devuelve una sola vez al administrador que crea la cuenta.
    SMTP_URL: z.string().startsWith('smtp').optional(),
    SMTP_FROM: z.string().min(3).optional(),

    DOCS_HABILITADOS: booleano.optional(),
    TAREAS_HABILITADAS: booleano.default(true),
    // Solo desarrollo local sin Supabase: URLs de Storage ficticias y todo
    // archivo se da por subido. Prohibido en producción.
    STORAGE_SIMULADO: booleano.default(false),
    CORS_ORIGENES: z
      .string()
      .optional()
      .transform((v) =>
        v
          ? v
              .split(',')
              .map((o) => o.trim())
              .filter(Boolean)
          : [],
      ),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === 'production' && c.STORAGE_SIMULADO) {
      ctx.addIssue({
        code: 'custom',
        path: ['STORAGE_SIMULADO'],
        message: 'no se permite en producción',
      });
    }
    if (c.NODE_ENV === 'production' && !c.GOOGLE_MAPS_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['GOOGLE_MAPS_API_KEY'],
        message: 'obligatoria en producción',
      });
    }
    if (c.SMTP_URL && !c.SMTP_FROM) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_FROM'],
        message: 'obligatoria cuando se define SMTP_URL',
      });
    }
  });

export type Configuracion = z.infer<typeof esquema>;

/** Valida las variables de entorno al arrancar: si falta una, la API no inicia. */
export function validarConfiguracion(
  entorno: Record<string, unknown>,
): Configuracion {
  const resultado = esquema.safeParse(entorno);
  if (!resultado.success) {
    const detalle = resultado.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuración inválida:\n${detalle}`);
  }
  return resultado.data;
}

@Injectable()
export class ConfigApp {
  constructor(private readonly config: ConfigService<Configuracion, true>) {}

  get<K extends keyof Configuracion>(clave: K): Configuracion[K] {
    return this.config.get(clave, { infer: true });
  }

  get esProduccion(): boolean {
    return this.get('NODE_ENV') === 'production';
  }
}
