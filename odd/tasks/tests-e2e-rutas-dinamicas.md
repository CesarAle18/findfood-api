# Tests e2e alineados con las rutas dinámicas

## Objective

Make `npm run test:e2e` green again by updating the e2e suites that still assume the pre-dynamic-routes acceptance flow.

## Problem

Commit `72aaaab Implementacion rutas dinamicas` changed `AsignacionService.aceptar` (`src/modulos/asignacion/asignacion.service.ts:282-347`): accepting an offer now calls `RutasDinamicasService.incorporar`, which adds the donation to the volunteer's active route (creating one `EN_CURSO` when absent), and moves the donation `PUBLICADA → ASIGNADA → EN_RECOLECCION` in the same transaction. The response is `{ id, estado: 'ACEPTADA', ruta: { id, estado: 'EN_CURSO', actualizada: true } }`.

`test/flujo-completo.e2e-spec.ts`, `test/asignacion.e2e-spec.ts` and `test/ruteo.e2e-spec.ts` were never updated: they expect `ASIGNADA` after accepting and build routes manually with `POST /v1/rutas` + `/iniciar`, which now returns 409 (`ruteo.service.ts:183` requires `ASIGNADA` and no `ruta_id`). 17 tests fail, most in cascade.

## Why

Dynamic routes are the current design (`seguimiento` and `rutas-vencidas` suites already rely on it). The tests, not the code, are stale.

## Scope

- Authorized: edit the three e2e spec files above (and shared e2e helpers only if strictly needed).
- Out of scope: any change under `src/`. If a test reveals a genuine product bug, stop and report it instead of changing code.

## Constraints

- Spanish domain vocabulary in test names and comments.
- Each e2e file keeps its own geographic zone; tests run in band against one shared DB.
- Run tests only through the npm scripts.

## Tasks

- [x] T1 — `flujo-completo`: accepting yields `EN_RECOLECCION` and returns the route; the rest of the flow (arrival, confirmations, delivery, reception, history, rating, FEFO, push, KPIs) uses that route. History expectation updated to the new state sequence.
- [ ] T2 — `asignacion`: "cancelar una donación asignada…" reflects the post-acceptance state (`EN_RECOLECCION` inside a dynamic route) and still asserts the offer closes and the volunteer is notified, or documents the new expected outcome.
- [ ] T3 — `ruteo`: grouping/ordering, dispersion, capacity and foreign-assignment rules exercised through successive acceptances (`incorporar`) instead of `POST /v1/rutas`; the `asignada()` helper no longer collides with routes left active by earlier tests.

## Acceptance criteria

- `npm run test:e2e` passes in full (104 tests or the adjusted count).
- `npm run lint` and `npm run typecheck` pass.
- No change under `src/`.

## Checks

- `npm run test:e2e -- test/flujo-completo`, `test/asignacion`, `test/ruteo` per task; full `npm run test:e2e`, `npm run lint`, `npm run typecheck` at close.
- Test-first exception: the failing tests are themselves the RED evidence (CI run pasted by the user, 17 failing); GREEN is the same suites passing.

## Routing

- Route: delegated direct (one writer). Trigger: writer trigger, 3 non-trivial test files, plus preparation reading of `rutas-dinamicas.service.ts` / `planificador-dinamico.ts`.
- Delivery strategy: `ask-on-risk`. Forecast: ~300 authored changed lines (under the ~400 budget).
- Engram mirror `odd/tests-e2e-rutas-dinamicas/tasks`: pending (Engram tools unavailable in the parent session).

## Progress

- Baseline: 3 suites / 17 tests failing (CI output, 2026-10-24); reproduced locally: `npm run test:e2e -- test/flujo-completo test/asignacion test/ruteo` → 17 failed, 19 passed.
- T1 (route: delegated direct, writer): accept now asserts `{ id, estado: ACEPTADA, ruta: { estado: EN_CURSO, actualizada: true } }`, donation `EN_RECOLECCION`; the manual `POST /v1/rutas` + `/iniciar` steps were replaced by reading the route returned on accept (`EN_CURSO`, RECOGIDA + ENTREGA at the dry sede, no geometry without Google) and a no-op `/iniciar`. The DONACION history sequence is unchanged (accept writes ASIGNADA and EN_RECOLECCION in one transaction). Check: `npm run test:e2e -- test/flujo-completo` → 14 passed, 14 total. Commit: `test(asignacion): flujo completo sobre la ruta dinámica creada al aceptar` (hash recorded with T2, since a commit cannot contain its own hash).

## Next step

T2.
