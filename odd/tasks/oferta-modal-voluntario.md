# Feature · oferta-modal-voluntario (API side)

**Locator:** `odd/tasks/oferta-modal-voluntario.md` in both repos. The app doc (findfood-app-mobile) is canonical for the feature; this file covers the API task only.
**Branch:** `feat/oferta-modal-voluntario` (findfood-api, from `Conexion_Front` @ `95282aa`)

## Objective
After a volunteer accepts an offer, the route map always ends up with a street path. A failed post-accept trace no longer leaves the route without geometry for good.

## Problem / Why
- `AsignacionService.aceptar` runs `RutasDinamicasService.incorporar` in the transaction. That call sets `geometria`, `proveedor_ruteo` and `distancia_total_km` to `NULL`. After the commit it awaits `trazar()`.
- If `trazar()` returns early, the route stays `geometria NULL`. That happens when Google doesn't answer, when there is no route, or when the order guard discards the write.
- Nothing retried it: `retrazarPendiente` only runs when a stop closes, or on expire, cancel or reassign. The app showed the stops with no path.

## Scope / constraints
- No business-rule, endpoint or schema change. Conventional commits in Spanish, no Co-Authored-By trailer; push/PR are the user's decision.
- Respect the order guard in `trazar()` and the rule that a retrace keeps the planned `distancia_total_km` (route-map-lines T7).

## Tasks
- [x] T14 retry the street trace for active routes left without geometry. Route: delegated writer (2+ non-trivial files: service, job, specs). Commit `692f093`.
  - `RuteoService.retrazarRutasSinTrazado(lote = 10)`, triggered by the new `retrazar_rutas_sin_trazado` job in `TareasService` (`EVERY_MINUTE`, through `ejecutar`: honors `TAREAS_HABILITADAS`, skips overlapping runs).
  - Selects `PLANIFICADA`/`EN_CURSO` routes of a volunteer with `geometria IS NULL` and a `PENDIENTE`/`EN_SITIO` stop. The route must have changed (`GREATEST(ruta.updated_at, max(parada_ruta.updated_at))`) between 1 and 10 minutes ago, newest first, `LIMIT lote`.
    - The 1-minute wait lets the accept's own trace finish.
    - The 10-minute window caps Google calls when there is no path to draw: about 9 attempts per route change. The window is stateless, so a restart loses nothing.
  - Origin: the same as the accept, the volunteer's location if under 30 min old (`UBICACION_RECIENTE_MIN`), otherwise the last COMPLETADA/FALLIDA stop, otherwise `ubicacion_base`. Rows without an origin are skipped.
  - Distance: `conservarDistancia` is true when `distancia_total_km` is set, so the planned distance stays. It is false only when the accept left it `NULL`, which is what the post-accept `trazar()` would have written.
  - "Google not configured" is `GoogleRoutesService.disponible === false`: the job returns 0 without querying the database.
  - Routes run one by one through the new `AsignacionService.trazarPendiente`, which awaits `trazar()`. A thrown error logs `warn {err, rutaId}` and the job moves on to the next route. A final query logs `warn {rutaId}` for each route still without geometry. The log carries no PII.
  - Sync: a successful write updates `ruta.geometria`, which fires `tg_ruta_sincronizar_upd` (`AFTER UPDATE OF estado, geometria`, `supabase/migrations/20261108000001_sincronizacion_flujo.sql:157-161`), so the app is notified. No change there.
  - RED: `npm test -- src/modulos/ruteo/ruteo.service.spec.ts src/modulos/asignacion/asignacion.service.spec.ts` gave 7 failed, 14 passed (`retrazarRutasSinTrazado` / `trazarPendiente is not a function`). GREEN: 21 passed.

## Acceptance criteria
- With a Google key, an active route left without geometry after an accept gets its street geometry within a few minutes, and the app is notified.
- Without a Google key, the job doesn't query or call anything.
- Finished and cancelled routes are never retraced; a planned `distancia_total_km` is never overwritten.

## Checks
`npm run typecheck`, `npm run lint`, `npm test`.

## Verification evidence (T14, on `692f093`)
- `npm test -- src/modulos/ruteo/ruteo.service.spec.ts src/modulos/asignacion/asignacion.service.spec.ts`: 2 suites, 21 tests passed.
- `npm test`: 21 suites, 167 tests passed.
- `npm run typecheck`: exit 0.
- `npm run lint`: 0 errors. 2 warnings, both pre-existing in untouched files (`rutas-dinamicas.service.ts:2` unused `Prisma`, `test/asignacion.e2e-spec.ts:306`), the same as in route-map-lines.
- E2E: not run. They need the local Postgres on `127.0.0.1:54329` (connection refused) and Docker isn't running. The selection SQL is verified by text in unit tests only, not against a live database.

## Out of scope / follow-up
- Fleet routes (`voluntario_id NULL`) are not retried: the app doesn't draw them, and they would need the bank as origin.
- `docs/arquitectura.md` (job table near line 393) doesn't list `retrazar_rutas_sin_trazado` yet. It was outside this task's edit surface.
- The post-accept `trazar()` still returns silently when Google returns no trace. The job now logs that case with the route id after its own attempt.
