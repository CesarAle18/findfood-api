# Feature · route-map-lines

**Locator:** `odd/tasks/route-map-lines.md` in both repos (Engram mirror `odd/route-map-lines/tasks`: pending — Engram tools unavailable in the orchestrator session)
**Branch:** `fix/route-geometry-quality` (findfood-api, from `origin/Conexion_Front` @ `9ec2b4c`) · `fix/route-map-lines` (app, from `develop` @ `fa7c235`)

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
  - Gap: `omitirParada` runs inside `cerrarVigentes`, whose callers own the transaction in `donaciones.service.ts` (expire at ~210, cancel at ~940/~1006). Those paths do not retrace yet; they need a post-commit call there (outside this task's edit surface).
  - Side effect: `trazar` also rewrites `distancia_total_km` to the remaining distance (as it already did for dynamic routes), so after a stop closes it no longer holds the planned total.
- [ ] T4 (app) `RouteMapView` draws the planned path only when `proveedor_ruteo === "GOOGLE"`; the next leg only when `tramo.proveedor === "GOOGLE"`. Route: delegated writer (app, with T5).
- [ ] T5 (app) `NextStopEta` shows the displayed stop number (by `parada.id`), falling back to the API `orden`. Route: delegated writer.

Route evidence: each repo touches 2+ non-trivial files (service + specs; component + screen + tests) → writer trigger.

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
