import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './comun/auth/auth.module';
import type { PeticionAutenticada } from './comun/auth/decoradores';
import { CorreoModule } from './comun/correo/correo.module';
import { GoogleModule } from './comun/google/google.module';
import { PrismaModule } from './comun/prisma/prisma.module';
import { SupabaseModule } from './comun/supabase/supabase.module';
import { TrazabilidadModule } from './comun/trazabilidad/trazabilidad.module';
import { ConfigAppModule } from './config/config.module';
import { ConfigApp } from './config/configuracion';
import { AdminModule } from './modulos/admin/admin.module';
import { AsignacionModule } from './modulos/asignacion/asignacion.module';
import { DonacionesModule } from './modulos/donaciones/donaciones.module';
import { EvidenciasModule } from './modulos/evidencias/evidencias.module';
import { IdentidadModule } from './modulos/identidad/identidad.module';
import { IncidenciasModule } from './modulos/incidencias/incidencias.module';
import { InventarioModule } from './modulos/inventario/inventario.module';
import { NotificacionesModule } from './modulos/notificaciones/notificaciones.module';
import { ParametrosModule } from './modulos/parametros/parametros.module';
import { RuteoModule } from './modulos/ruteo/ruteo.module';
import { SaludModule } from './modulos/salud/salud.module';
import { TareasModule } from './modulos/tareas/tareas.module';

@Module({
  imports: [
    ConfigAppModule,
    LoggerModule.forRootAsync({
      inject: [ConfigApp],
      useFactory: (config: ConfigApp) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          transport:
            config.get('NODE_ENV') === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
          redact: ['req.headers.authorization', 'req.headers.cookie'],
          // Id de la petición y del usuario en cada línea (§16).
          customProps: (req) => ({
            usuario_id: (req as PeticionAutenticada).usuario?.id,
          }),
          autoLogging: { ignore: (req) => req.url === '/health' },
        },
      }),
    }),
    // Transversales (globales)
    PrismaModule,
    SupabaseModule,
    GoogleModule,
    CorreoModule,
    TrazabilidadModule,
    AuthModule,
    ParametrosModule,
    // Dominio
    SaludModule,
    NotificacionesModule,
    EvidenciasModule,
    IdentidadModule,
    AdminModule,
    DonacionesModule,
    AsignacionModule,
    IncidenciasModule,
    RuteoModule,
    InventarioModule,
    TareasModule,
  ],
})
export class AppModule {}
