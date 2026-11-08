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
- [x] T2 (app) confirm copy in `src/screens/route.tsx` and comments in `src/services/rutas.ts`. Route: inline (mechanical copy/comments). Commit `9ac9a50`.
- [x] T3 (app) when the donation is PUBLICADA again, "Voluntario asignado" (`/donante/voluntario-asignado`) and "Seguimiento" (`/donante/seguimiento`) replace themselves with "Donación publicada" (`/donante/espera-voluntario`, the magnifier screen); `DONACION_REPUBLICADA` opens `/donante/espera-voluntario`. User decision 2026-11-07 (single waiting screen). Route: delegated writer (3+ files with tests). Commit `d8062ee`.

## Acceptance criteria
- After a volunteer cancels a PLANIFICADA route: each donation is PUBLICADA (or EXPIRADA without margin), its assignment CANCELADA, and the donor has a `DONACION_REPUBLICADA` notification.
- The donor's waiting screen shows the "search" icon and "Estamos buscando un voluntario" without reloading.

## Checks
- API: `npm run lint`, `npm run typecheck`, `npm test`, e2e of the touched suites (needs local DB).
- App: `npm run lint`, `npm run typecheck`, jest for route screens.

## Progress
- 2026-11-07: explored; user chose to release donations; branches created; feature document created.
- 2026-11-07: T1 done in findfood-api commit `fcb69d8` (`fix(ruteo): liberar las donaciones al cancelar una ruta de voluntario`). `RuteoService.cancelar` runs the fleet release loop for both route kinds (volunteer motivos: "Ruta cancelada por el voluntario" / "... sin margen para otra recogida"; no `notificar`). `cerrarVigentes`' `omitirParada`/`cancelarRutaVacia` are no-ops here (stops already OMITIDA, route already CANCELADA). New e2e case in `test/ruteo.e2e-spec.ts`; no existing test asserted the old behavior. Test-first: RED observed (donation stayed `ASIGNADA`), then GREEN. Checks: `npm run lint` 0 errors, 2 pre-existing warnings; `npm run typecheck` clean; `npm test` 134/134; `npm run test:e2e -- test/ruteo test/avisos test/sincronizacion test/asignacion` 62/62; full `npm run test:e2e` 159/159.
- 2026-11-07: T2 done in the app, commit `9ac9a50`. Copy/comment-only change, no meaningful RED. Checks: `npm run typecheck` exit 0 · `npx eslint src/screens/route.tsx src/services/rutas.ts` exit 0 · `npx jest src/services/rutas src/screens/__tests__` 24 suites / 366 tests passed.
  - Review assess (app, `--base-ref develop --committed-only --untracked-scope=exclude`): risk `medium` (`executable_change` src/screens/route.tsx), 8 lines, `review_due: false` / `under_budget` → stays pending in the slice.
- 2026-11-07: T1 report reviewed: in the current API flow a volunteer route created by accepting an offer starts EN_CURSO, so "Cancelar ruta" only applies to hand-grouped PLANIFICADA routes; on EN_CURSO routes the volunteer abandons (`POST /asignaciones/:id/abandonar`), which already republishes. The remaining gap is in the app: the magnifier lives only on `/donante/espera-voluntario`, which the donor sees only right after publishing. T3 added.
- 2026-11-07: T3 done in the app, commit `d8062ee` (`fix(donante): volver a la pantalla de espera cuando la donación se republica`). New `useRedirectWhilePublished(id, detail)` in `src/screens/donation-queries.ts` (`useEffect` + `router.replace({ pathname: "/donante/espera-voluntario", params: { id } })` when `estado === "PUBLICADA"` and the query is not fetching), used by `AssignedVolunteerScreen` and `TrackingScreen`; `DONACION_REPUBLICADA` → `/donante/espera-voluntario` with `?id=`. Tests: new redirect cases (initial PUBLICADA, PUBLICADA after a refetch, no redirect for ASIGNADA) in `tracking-screens.test.tsx`; two old tests that rendered PUBLICADA on those screens now use EXPIRADA (empty state / no live tracking kept). Test-first: RED 4 failing (`DONACION_REPUBLICADA` route + 3 redirect cases), then GREEN 102/102 in the 3 touched suites. Checks: `npm run typecheck` exit 0 · `npx eslint src/screens src/notifications` exit 0 · `npx jest src/notifications src/screens` 27 suites / 425 tests passed.
- 2026-11-07: parent checks. Spot check `npx jest src/notifications src/screens` 27 suites / 425 tests passed; API `npm run typecheck` exit 0. Review assess: API `--base-ref ec085ae` risk `medium`, 143 lines, `under_budget`; app `--base-ref develop` risk `medium`, 154 lines, `under_budget` → no review due; both slices stay pending under the budget. Next: manual end-to-end check by the user; push/PR are the user's decision.
