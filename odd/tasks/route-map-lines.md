# Feature · route-map-lines

**Locator:** `odd/tasks/route-map-lines.md` in both repos (Engram mirror `odd/route-map-lines/tasks`: pending — Engram tools unavailable in the orchestrator session)
**Branch:** `fix/route-geometry-quality` (findfood-api, from `origin/Conexion_Front` @ `f113c81`) · `fix/route-map-lines` (app, from `develop` @ `fa7c235`)

## Objective
The volunteer's route map draws lines that follow the streets: no corner-cutting zigzags, no straight stop-to-stop segments posing as a route, no stale spur from where the route was planned, and the ETA card names the stop the blue leg actually reaches.

## Problem / Why
Reported 2026-11-17 with a screenshot of `RUT-261111-VJADH`:
1. `GoogleRoutesService.ruta()` never sends `polylineQuality`, so Google returns the simplified `OVERVIEW` polyline: few points, cuts across blocks.
2. On Google failure a planned route stores the stops as a straight `LINESTRING`; `seguimiento` returns a 2-point `ESTIMADO` leg. The app draws both like street geometry.
3. Route geometry starts at the planning-time origin and is never retraced when stops close, so it keeps a spur and the legs already driven.
4. App: `RouteDetail` renumbers stops 1..n (OMITIDA dropped) but `NextStopEta` prints the API's `orden` ("parada 3" while the blue leg ends at marker 2).

## Scope / constraints
- The app's GeoJSON decoding is correct (`lineStringToLatLngs`); no client-side simplification exists.
- Conventional commits without Co-Authored-By trailers; tests ship with code; push/PR are the user's decision.
- Delivery strategy: `ask-on-risk`. Forecast ≈ 150 authored lines (≈ 90 API, ≈ 60 app); each repo stays one PR.

## Tasks
- [x] T1 (findfood-api) `polylineQuality: 'HIGH_QUALITY'` in `GoogleRoutesService.ruta()` + unit test. Route: delegated writer (API, with T2–T3). Commit `086de1d`. RED: `google-routes.service.spec.ts` "pide la polilínea de alta calidad" failed (`Received: undefined`); GREEN after the change.
- [x] T2 (findfood-api) planned routes store `geometria = NULL` instead of the straight stop `LINESTRING` when Google returns null. Route: delegated writer. Commit `94f2b44`. `proveedor_ruteo` is now `'GOOGLE'` only when Compute Routes traced the route (it was `matriz || trazado`); otherwise `NULL`. The audit metadata `proveedor` (ordering method) is unchanged. RED: new `ruteo.service.spec.ts` got `ST_GeomFromText(?, 4326)`; GREEN after the change.
- [x] T3 (findfood-api) retrace the pending path (`trazar`) from the closed stop after `confirmar`, `fallida` and `omitirParada`, fire-and-forget. Route: delegated writer. Commit `9d4286f`. `AsignacionService.retrazarPendiente(rutaId, desde)` wraps `RutasDinamicasService.trazar` as `void …catch(warn)`; `RuteoService` already injects `AsignacionService`, so no module wiring changed and there is no circular import. Called after commit from `confirmar` (RECOGIDA only), `fallida` (unless the route was cancelled) and `abandonar` (via `omitirParada`, which now returns the omitted stop's `ST_Y/ST_X`). RED: the confirmar/fallida/abandonar trigger tests failed before wiring; GREEN after.
  - Gap: `omitirParada` runs inside `cerrarVigentes`, whose callers own the transaction in `donaciones.service.ts` (expire at ~210, cancel at ~940/~1006). Those paths do not retrace yet; they need a post-commit call there (outside this task's edit surface). → closed by T6.
  - Side effect: `trazar` also rewrites `distancia_total_km` to the remaining distance (as it already did for dynamic routes), so after a stop closes it no longer holds the planned total. → closed by T7.
- [x] T6 (findfood-api) retrace when a donation expires, is cancelled or is reassigned on a live route. Route: delegated writer (API, with T7). Commit `3e0bcb2`. `cerrarVigentes` now returns `RetrazoPendiente[]` (`{ rutaId, desde }` per stop it left OMITIDA; it returned an unused count before) — `asignacion.service.ts` `RetrazoPendiente` + `cerrarVigentes`. `DonacionesService` collects them from the transaction and calls `retrazar()` → `asignacion.retrazarPendiente` after commit in `expirarPublicacionesVencidas`, `cancelar` and `reasignar`; endpoint responses are unchanged and nothing is called when no stop was skipped. DI: `DonacionesService` already injects `AsignacionService` via the existing `forwardRef` (modules are already mutually `forwardRef`-imported), so no wiring changed. Other `cerrarVigentes` callers (accept, fleet, route cancel/expiry in `ruteo`) ignore the result: they close OFRECIDA offers or cancel the whole route. RED: new `donaciones.service.spec.ts` (cancelar/reasignar/expirar: 0 calls) and `asignacion.service.spec.ts` cerrarVigentes tests (`Received: 1` / `2`); GREEN after.
- [x] T7 (findfood-api) keep the planned distance on a retrace. Route: delegated writer. Commit `a8ed228`. `RutasDinamicasService.trazar(rutaId, origen, { conservarDistancia })` writes `distancia_total_km = COALESCE(${km}::numeric, distancia_total_km)` with `km = null` when conserving; geometry, `proveedor_ruteo` and the pending-stop signature guard are unchanged. `retrazarPendiente` passes `conservarDistancia: true`; the accept-time dynamic trace keeps the default (distance overwritten). RED: new `rutas-dinamicas.service.spec.ts` "con conservarDistancia…" (`Received array: ["abc", 3.46, …]`) and updated `retrazarPendiente`/`abandonar` expectations; GREEN after.
- [x] T4 (app) `RouteMapView` draws the planned path only when `proveedor_ruteo === "GOOGLE"`; the next leg only when `tramo.proveedor === "GOOGLE"`. Route: delegated writer (app, with T5). Commit `ed37ce2` (app repo).
- [x] T5 (app) `NextStopEta` shows the displayed stop number (by `parada.id`), falling back to the API `orden`. Route: delegated writer. Commit `dc22975` (app repo).

Route evidence: each repo touches 2+ non-trivial files (service + specs; component + screen + tests) → writer trigger.

## Review (native RDD)
- findfood-api `9ec2b4c..2b1d918` (T1–T3; the range also held upstream `f113c81`): risk medium, `slice_budget_reached` (704 lines) → consent granted → 1 lens (review-reliability) → approved; acknowledged, authority burned (lineage `review-b556308726265c40`). Reviewer note: the `fallida` auto-cancel block belongs to upstream `f113c81`, not to this feature.
- findfood-api `2b1d918..198e48b` (T6–T7): risk medium, `under_budget` (360 lines) → no review due; pending in the slice.
- app `fa7c235..a9ac29a` (T4–T5): risk medium, `under_budget` (185 lines) → no review due.

## Acceptance criteria
- With a Google key, `GET /v1/rutas/:id` `geometria` is the high-quality polyline and, after a stop closes, starts at that stop.
- Without Google, `geometria` is `null` and the app shows the stops only; an `ESTIMADO` leg is not drawn.
- The ETA card's stop number matches the marker the blue leg ends at.

## Checks
- API: `npm run lint`, `npm run typecheck` (if present), `npm test`.
- App: `npm run lint`, `npm run typecheck`, jest for map + route screen.

## Out of scope / follow-up
- `seguimiento` caches a leg for up to 2 min / 2 km (`seguimiento.service.ts:20-22`), so the blue leg may start slightly behind the device.

## Verification evidence (findfood-api, T1–T3)
- `npm run lint`: exit 0, 0 errors; 2 pre-existing warnings in untouched files (`rutas-dinamicas.service.ts:2` unused `Prisma`, `test/asignacion.e2e-spec.ts:306`).
- `npm run typecheck`: exit 0.
- `npm test`: 19 suites, 150 tests passed.
- E2E specs: none touched or run (they need a database).

## Verification evidence (findfood-api, T6–T7)
- `npm run lint`: 0 errors; the same 2 pre-existing warnings.
- `npm run typecheck`: exit 0.
- `npm test`: 21 suites, 160 tests passed.
- E2E specs: not run (they need a database).
