# Feature · cancelar-ruta-libera-donaciones

**Locator:** `odd/tasks/cancelar-ruta-libera-donaciones.md` in both repos (Engram mirror `odd/cancelar-ruta-libera-donaciones/tasks`: pending — Engram tools unavailable in the orchestrator session)
**Branch:** `fix/cancelar-ruta-libera-donaciones` (findfood-api, from `Conexion_Front` @ `ec085ae`) · `fix/cancelar-ruta-libera-donaciones` (app, from `develop` @ `2ab0760`)

## Objective
When a volunteer cancels a PLANIFICADA route, its donations are released: they go back to PUBLICADA (or EXPIRADA when the pickup window leaves no margin) and are offered again, so the donor's "Donación publicada" screen shows the search magnifier ("Estamos buscando un voluntario") again.

## Problem / Why
`RuteoService.cancelar` only detached a volunteer route's assignments (`ruta_id = null`): they stayed ACEPTADA and the donations ASIGNADA, so the donor kept seeing "Un voluntario aceptó tu donación" while nobody was coming. User decision (2026-11-07): cancelling the route releases the donations.

## Scope / constraints
- Volunteer routes behave like bank-fleet routes already did: assignment CANCELADA (not an abandonment), `reabrirPublicacion` from ASIGNADA, else `expirar`; re-offer after the transaction.
- The donor app needs no logic change: `reabrirPublicacion` enqueues `DONACION_REPUBLICADA` and the sync events invalidate the donation detail. Only the volunteer's confirm copy and comments change.
- Conventional commits without Co-Authored-By trailers; tests ship with code; push/PR are the user's decision.
- Delivery strategy: `ask-on-risk`. Forecast ≈ 80 authored lines (≈ 70 API, ≈ 6 app); each repo stays one PR.

## Tasks
- [x] T1 (findfood-api) `RuteoService.cancelar` releases volunteer-route donations; e2e coverage; update tests that asserted the old behavior. Route: delegated writer (service + e2e spec, 2 non-trivial files).
- [ ] T2 (app) confirm copy in `src/screens/route.tsx` and comments in `src/services/rutas.ts`. Route: inline (mechanical copy/comments).

## Acceptance criteria
- After a volunteer cancels a PLANIFICADA route: each donation is PUBLICADA (or EXPIRADA without margin), its assignment CANCELADA, and the donor has a `DONACION_REPUBLICADA` notification.
- The donor's waiting screen shows the "search" icon and "Estamos buscando un voluntario" without reloading.

## Checks
- API: `npm run lint`, `npm run typecheck`, `npm test`, e2e of the touched suites (needs local DB).
- App: `npm run lint`, `npm run typecheck`, jest for route screens.

## Progress
- 2026-11-07: explored; user chose to release donations; branches created; feature document created.
- 2026-11-07: T1 done in findfood-api commit `fcb69d8` (`fix(ruteo): liberar las donaciones al cancelar una ruta de voluntario`). `RuteoService.cancelar` runs the fleet release loop for both route kinds (volunteer motivos: "Ruta cancelada por el voluntario" / "... sin margen para otra recogida"; no `notificar`). `cerrarVigentes`' `omitirParada`/`cancelarRutaVacia` are no-ops here (stops already OMITIDA, route already CANCELADA). New e2e case in `test/ruteo.e2e-spec.ts`; no existing test asserted the old behavior. Test-first: RED observed (donation stayed `ASIGNADA`), then GREEN. Checks: `npm run lint` 0 errors, 2 pre-existing warnings; `npm run typecheck` clean; `npm test` 134/134; `npm run test:e2e -- test/ruteo test/avisos test/sincronizacion test/asignacion` 62/62; full `npm run test:e2e` 159/159.
  - Note: with dynamic routes, accepting an offer puts the donation straight into EN_RECOLECCION inside an EN_CURSO route, so a volunteer route is PLANIFICADA only when it was grouped by hand with `POST /v1/rutas` from an ACEPTADA assignment with no route and an ASIGNADA donation. The e2e fixture sets up that state with SQL. EN_CURSO dynamic routes still answer 409 `ruta-no-cancelable`.
