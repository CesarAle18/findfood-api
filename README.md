# FindFood API

Backend de FindFood: gestión y trazabilidad de donaciones de alimentos con asignación optimizada de voluntarios. Es un monolito modular en NestJS 12 sobre Supabase (Postgres + PostGIS, Auth, Storage, Realtime). Lo consumen la app móvil (donantes y voluntarios) y el panel web (administración y asesores del banco).

El diseño completo está en [`docs/arquitectura.md`](docs/arquitectura.md). El esquema de la base es la migración SQL de [`supabase/migrations/`](supabase/migrations/) (DDL v3). Cuando algo de este README contradiga esos dos documentos, mandan ellos.

## Puesta en marcha local

Requisitos: Node 24 y Podman o Docker.

```bash
npm install                  # también genera el cliente de Prisma (postinstall)
cp .env.example .env         # y completa las variables de Supabase
npm run db:local             # PostGIS 16 + 3.4 en un contenedor, con las migraciones aplicadas
npm run start:dev            # http://localhost:3000 · OpenAPI en /docs · salud en /health
```

`npm run db:local` levanta PostgreSQL 16 + PostGIS 3.4 en `127.0.0.1:54329`, simula lo mínimo de Supabase (`auth.users`, `auth.uid()`, `realtime.*`, roles `anon`/`authenticated`; ver [`db/local/simulacion_supabase.sql`](db/local/simulacion_supabase.sql)) y aplica las migraciones **sin modificarlas**. Crea las bases `findfood` (desarrollo) y `findfood_test`, y da contraseña local al rol `app_backend`.

En local no hay GoTrue. Para crear cuentas, inserta en `auth.users` como `postgres`: los disparadores del DDL crean el perfil. Para firmar tokens, define `SUPABASE_JWT_SECRET` en `.env` y firma JWT HS256 con `iss = <SUPABASE_URL>/auth/v1` y `aud = authenticated`.

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run start:dev` | API en modo *watch* |
| `npm run build` / `npm run start:prod` | Compila a `dist/` y arranca la versión compilada |
| `npm run lint` · `npm run typecheck` · `npm run format` | oxlint con tipos, `tsc` (incluye las pruebas) y Prettier |
| `npm test` | Pruebas unitarias (`src/**/*.spec.ts`) |
| `npm test -- src/modulos/ruteo` · `npm test -- -t 'FEFO'` | Un archivo o una prueba por nombre |
| `npm run test:e2e` | Pruebas e2e contra PostgreSQL real (ver abajo) |
| `npm run db:local` · `npm run db:local:reiniciar` | Base local; `scripts/db-local.sh psql` abre una consola |
| `npm run db:pull` | Introspección (`prisma db pull`) y `prisma generate` |

## Pruebas

- **Unitarias:** puntaje del motor, urgencia, orden de paradas (con el *benchmark* de §3.2), teléfono, fechas en Bogotá y errores de PostgreSQL.
- **e2e** (`test/*.e2e-spec.ts`):
  - Cada corrida **recrea** la base `findfood_e2e` desde las migraciones, en el servidor de `TEST_ADMIN_DATABASE_URL` (por defecto el de `npm run db:local`).
  - La API se conecta como `app_backend`, igual que en producción, así que también se prueban los privilegios del DDL.
  - Supabase Auth se simula insertando en `auth.users`, de modo que corren los disparadores reales. Storage y push son dobles en memoria.
  - Cubren:
    - guards y estados de cuenta;
    - el hallazgo crítico #1 (nadie se registra como ADMIN);
    - RLS y privilegios (P5);
    - el flujo completo creación → recepción con trazabilidad;
    - filtros duros, plazos y cascada, incluida la invariante "nunca dos ofertas vivas" bajo concurrencia;
    - ruteo;
    - FEFO y libro mayor.
- **CI** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)): lint, tipos, unitarias, e2e con PostGIS como servicio y *build*.

## Base de datos

- **Fuente de verdad:** `supabase/migrations/`. Para cambiar el esquema: nueva migración SQL → `supabase db push` → `npm run db:pull`. **Nunca** `prisma migrate` ni `prisma db push`, porque borrarían lo que Prisma no sabe expresar (PostGIS, disparadores sobre `auth.users`, índices parciales, RLS, Realtime).
- **Toda tabla nueva** debe crearse con `ENABLE ROW LEVEL SECURITY` y la política `pol_app_backend`. Una prueba e2e lo verifica.
- **Introspección:** `prisma/schema.prisma` se generó contra la base local simulada. Vuelve a ejecutar `npm run db:pull` contra el proyecto real de Supabase, con `PRISMA_INTROSPECCION_URL` como `postgres`: allí `auth` tiene más tablas.
- **Relaciones erróneas:** Prisma interpreta los índices únicos **parciales** como relaciones 1:1. Por eso `donacion.asignacion`, `usuario.verificacion_identidad…` y `usuario.suspension_cuenta…` aparecen en singular aunque haya varias filas. El código nunca usa esas relaciones inversas: consulta la tabla hija con filtros explícitos.

## Despliegue (Railway)

- **Construcción y arranque:** `npm ci && npm run build`; luego `npm run start:prod`.
- **Healthcheck:** `/health`.
- **Suspensión por inactividad: desactivada.** Sin proceso vivo no hay reloj (§7).
- **Región:** la misma que el proyecto de Supabase (§4).
- **Variables:** las de [`.env.example`](.env.example). La API las valida al arrancar y no inicia si falta alguna obligatoria. En producción `GOOGLE_MAPS_API_KEY` es obligatoria.
- **Base de datos:** `DATABASE_URL` apunta al *pooler* en modo sesión con el usuario `app_backend.<ref>`. La contraseña del rol se asigna fuera del repositorio (`ALTER ROLE app_backend WITH LOGIN PASSWORD …`).
- **Documentación OpenAPI:** `/docs`, deshabilitada en producción salvo `DOCS_HABILITADOS=true`.

## Endpoints añadidos al contrato de §11

| Ruta | Para qué |
|---|---|
| `GET /v1/catalogos` | Tipos de alimento, unidades, vehículos, motivos, tipos de incidencia y destinos para los formularios |
| `GET /v1/me/notificaciones` · `POST …/{id}/leer` · `POST …/leer-todas` | Bandeja dentro de la app (§9.3). Leer una notificación en cola evita su push. |
| `GET /v1/evidencias?parada_id=…` | Evidencias con URL firmada de 5 min |
| `POST /v1/donaciones/{id}/reasignar` | ADMIN o ASESOR retiran la asignación y reinician la cascada |
| `GET /v1/rutas` · `POST /v1/rutas/{id}/cancelar` · `POST /v1/paradas/{id}/fallida` | Rutas propias; cancelar antes de iniciar; recogida imposible con incidencia |
| `GET /v1/incidencias/{id}` · `POST …/{id}/revisar` | Detalle y toma de la incidencia por el personal |
| `POST /v1/almacenes` | ADMIN crea sedes |
| `GET /v1/recepciones[/{id}]` · `GET /v1/inventario/lotes/{id}` | Consulta de recepciones y lote con su libro mayor |
| `GET /v1/distribuciones[/{id}]` · `POST …/{id}/anular` | Consulta y anulación de distribuciones |
| `GET /v1/kpis/resumen` | Indicadores del periodo |
| `GET/PUT /v1/admin/banco` · `POST/PATCH /v1/admin/tipos-alimento` | Configuración del único banco y del catálogo |
| `GET /v1/admin/usuarios` · `GET /v1/admin/verificaciones/{id}` · `GET /v1/admin/tareas` | Gestión de cuentas, documentos (URL de 60 s) y salud del reloj (§16) |

## Decisiones de implementación para revisar con el equipo

1. **Migración complementaria** [`20260922010000_soporte_api.sql`](supabase/migrations/20260922010000_soporte_api.sql). No crea tablas. Contiene:
   - tipos de notificación de verificación, cancelación y recepción;
   - motivos `OTRO` por ámbito;
   - un catálogo inicial de `tipo_alimento`, sin el cual no se puede crear ninguna donación;
   - `DELETE` sobre `donacion_item`, solo para editar borradores;
   - la función `fn_preparar_baja_sin_confirmar`.
2. **Hallazgo en el DDL v3.** La retención de cuentas sin confirmar (§7) falla tal cual: el alta crea siempre la fila en `donante`, cuya FK hacia `usuario` es `ON DELETE RESTRICT`, así que borrar el usuario en `auth.users` se bloquea. La función de la migración complementaria libera esa fila antes del borrado.
3. **Estados en calle:**
   - iniciar la ruta pasa la donación a `EN_RECOLECCION`;
   - confirmar la recogida, a `EN_TRANSITO`;
   - confirmar la entrega en la sede, a `ENTREGADA`, y la asignación queda `COMPLETADA`;
   - la recepción la deja `RECIBIDA` o `RECHAZADA`.
4. **Idempotencia por estado.** No se guarda la cabecera `Idempotency-Key`. Reenviar una confirmación ya hecha por la misma persona devuelve 200 sin efectos, y las evidencias usan el `id` generado en el móvil.
5. **Distribución.** Crearla reserva el stock (SALIDA en la misma transacción), confirmarla registra el despacho y anularla devuelve el stock con DEVOLUCION. FEFO nunca despacha lotes con la fecha cumplida en hora de Bogotá.
6. **Puntaje (§6.4):**
   - La proximidad usa referencia fija (recorrer el radio de búsqueda a 20 km/h), como recomienda el documento. Holgura temporal, confiabilidad y carga usan min–max.
   - Las "aceptadas" de la confiabilidad son COMPLETADA + ABANDONADA.
   - El ranking se guarda y solo se recalcula con Google cuando aparecen voluntarios factibles nuevos, para contener el costo (§15.2).
7. **Abandono sin margen.** Si la ventana ya no permite otra recogida, la donación pasa a EXPIRADA, se avisa al donante y se abre una incidencia `OTRO`.
8. **Incidencias.** No cambian estados por sí solas. El personal actúa con cancelar o reasignar. La parada fallida se registra con `/paradas/{id}/fallida`.
9. **Contraseña temporal.** Se envía por SMTP si `SMTP_URL` está definido. Si no, se devuelve **una sola vez** al ADMIN en la respuesta del alta (pregunta abierta §19.5).
10. **Suspensión.** Las sesiones se cierran con `ban_duration` en Supabase Auth, y el AuthGuard bloquea desde la siguiente petición.
11. **Push.** Expo Push, detrás de la interfaz `ProveedorPush`, para poder cambiar a FCM directo (§19.4).
12. **Observabilidad.** Logs JSON con `nestjs-pino`, con id de petición y de usuario. **Sentry no está integrado:** `@sentry/nestjs` todavía no declara compatibilidad con NestJS 12.
13. ***Benchmark* de ruteo (§3.2).** En 1 000 instancias de 2 a 5 paradas con la misma matriz, vecino más cercano + 2-opt queda en promedio a **0,23 %** del óptimo, pero el **peor caso llega a 19,4 %**. Si el criterio de "≤ 10 %" se lee por instancia, conviene usar la permutación óptima: con N ≤ 5 son 120 órdenes.
14. **Pendiente:** alertas de `STOCK_MINIMO` y `CAPACIDAD`. El CHECK de la tabla ya las admite.
