# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

FindFood backend: a NestJS 12 modular monolith for a single food bank in Bogotá (donations → volunteer assignment cascade → pickup routes → warehouse reception → FEFO inventory). It runs on Supabase (Postgres 16 + PostGIS, Auth, Storage, Realtime) and deploys to Railway as an always-on process.

- `docs/arquitectura.md` is the design (section numbers like §6.7 below refer to it).
- `supabase/migrations/` is the schema source of truth: `20260922000000_esquema_inicial.sql` (DDL v3), `20260922010000_soporte_api.sql`, `20261002000000_extensiones_supabase.sql`, `20261006000000_ajuste_interfaz_web.sql` (drops columns no UI exposes) and `20261009000000_unidades_ml_g.sql` (adds the ML and G units the mobile app offers).
- `README.md` lists the implementation decisions that deviate from or extend the doc. Read it before changing behavior.
- The domain vocabulary is Spanish (tables, enums, modules, DTO fields, error `type`s, comments). Keep new code in Spanish.

## Commands

```bash
npm run db:local          # PostGIS 16+3.4 container on 127.0.0.1:54329, migrations applied (needs podman/docker)
npm run start:dev         # API on :3000, OpenAPI at /docs, health at /health
npm run lint              # oxlint --type-aware (no-floating-promises is an error)
npm run typecheck         # tsc incl. test/
npm test                  # unit tests (src/**/*.spec.ts)
npm test -- -t 'FEFO'     # by name; or pass a path
npm run test:e2e          # needs the db:local server; recreates DB findfood_e2e from the migrations each run
npm run test:e2e -- test/asignacion   # single e2e file
npm run db:pull           # prisma db pull + generate (uses PRISMA_INTROSPECCION_URL as postgres)
npm run datos:prueba      # seeds the local DB, writes .env.local and the Postman environment (tokens)
npm run start:local       # API against the local DB (ENV_FILE=.env.local, STORAGE_SIMULADO=true)
```

- `.env` points at the real Supabase project, which still has the v2 schema. Use `start:local` for manual testing with `postman/FindFood.postman_collection.json`.

- Run tests through the npm scripts. Nest 12 is ESM, so Jest needs `--experimental-vm-modules`.
- e2e tests run in band against one shared database, and each file uses its own geographic zone so volunteers don't cross-match. Keep that pattern when adding suites.

## Database rules

- **Schema changes:** new SQL migration → `supabase db push` → `npm run db:pull`. **Never** run `prisma migrate` or `prisma db push`.
- **New tables** need `ENABLE ROW LEVEL SECURITY` plus a `pol_app_backend` policy. **New `fn_*`** need `REVOKE ALL … FROM PUBLIC, anon, authenticated`. An e2e test checks both.
- **Generated client:** `src/generated/prisma` is gitignored and rebuilt by `postinstall`. Import from `src/generated/prisma/client`.
- **Broken 1:1 relations:** Prisma introspects the partial unique indexes as 1:1 relations. `donacion.asignacion`, `usuario.verificacion_identidad_*` and `usuario.suspension_cuenta_*` are wrong: never read or filter through them. Query the child table with explicit filters.
- **Geography columns** are `Unsupported`, so `prisma.<model>.create` is unavailable for tables with a required geography column. Insert with `$queryRaw`/`$executeRaw` and `sqlPunto()` from `src/comun/geo.ts`, and read coordinates with `ST_Y/ST_X(col::geometry)`.
- **Privileges:** the API connects as `app_backend`. It has no DELETE except on `candidato_asignacion`, `notificacion`, `dispositivo_push` and `donacion_item`, and no access to the `auth` schema (only through SECURITY DEFINER `fn_*`).
- **Extensions schema:** on Supabase, PostGIS, citext and pgcrypto live in `extensions`, not `public`. `app_backend` reaches them through its role `search_path` (third migration). The local simulation (`db/local/simulacion_supabase.sql`) reproduces this layout, so a query that only works with PostGIS in `public` fails in the tests too.
- **Time zone:** sessions are UTC. Use `fechaBogota()` from `src/comun/tiempo.ts` for civil dates and SQL `now()` for deadlines. UTC dates near midnight are a known source of test flakiness.

## Architecture

- **Global infrastructure** (`src/comun/`): Prisma, Supabase (service role: Auth admin + Storage), Google Routes (always returns `null` on failure; callers fall back to geodesic distance), correo, trazabilidad (`historial_estado` + `auditoria`), auth guards.
- **Guards:** `AuthGuard` then `RolesGuard`, both global via `APP_GUARD`.
  - Every request loads `usuario` + active roles.
  - `@Publica()` skips authentication.
  - `@PermitirPendiente()` and `@PermitirPasswordTemporal()` let restricted accounts through (only `/v1/me`).
  - `@Roles()` intersects role sets.
- **Errors:** throw `Problema` (`src/comun/http/problema.ts`), which the global filter serializes as problem+json with a stable `type`.
  - DB errors are mapped by SQLSTATE through `codigoPostgres`. It skips Prisma's own `P2xxx` codes.
  - Use `violaUnicidad(err, 'uq_…')` to turn races into no-ops or 409s.
- **Serialization:** `SerializacionInterceptor` turns `Decimal` and `BigInt` into numbers.
- **State transitions:** every one writes `historial_estado` and any `notificacion` row in the same `prisma.transaccion()`. `notificacion` is the push outbox.
- **Module wiring** (`src/modulos/`):
  - `donaciones` ⇄ `asignacion` are mutually dependent via `forwardRef`: publishing starts the cascade, and accepting changes the donation state.
  - `ruteo` and `inventario` build on both.
  - Cross-module state changes go through exported tx-taking primitives: `DonacionesService.transicion/bloquear/reabrirPublicacion/expirar`, `AsignacionService.cerrarVigentes/completar/asignarAFlota`, `LotesService.mover`, `IncidenciasService.registrar`.
- **Assignment engine** (`asignacion/motor.service.ts`):
  - Stage 1 is `fn_candidatos_donacion`.
  - Stage 2 is Route Matrix. It runs **outside** transactions and only when the stored ranking has no valid next candidate but new feasible volunteers exist.
  - Scoring is the pure `puntaje.ts`.
  - Offers rely on `uq_asignacion_vigente` / `uq_asignacion_intento`. A losing concurrent insert returns `null`.
- **Pure, unit-tested logic:** `puntaje.ts`, `donaciones/urgencia.ts`, `ruteo/optimizacion.ts` (nearest neighbor + 2-opt + brute force).
- **Scheduled jobs:** `tareas/` only triggers (`@Cron`). The logic is in services, uses `FOR UPDATE SKIP LOCKED` and is idempotent. `TAREAS_HABILITADAS=false` in tests. Call the service methods directly (e.g. `MotorAsignacionService.vencerOfertas`).
- **Idempotency:** state-based. A repeated confirmation by the same user returns 200; evidence uses the client-generated `id`.
- **e2e harness** (`test/utilidades/app-de-pruebas.ts`):
  - `SupabaseFalso` creates users by inserting into `auth.users`, so the real DDL triggers run.
  - The app listens once on a real port. Supertest per-request listen/close breaks nested requests.
