# Feature · perfil-voluntario-editable

**Locator:** `odd/tasks/perfil-voluntario-editable.md` in both repos (Engram mirror `odd/perfil-voluntario-editable/tasks`: pending — Engram tools unavailable in the orchestrator session)
**Branch:** `feat/perfil-voluntario-editable` (app, from `develop` @ `a6c63ce`) · `feat/perfil-voluntario-editable` (findfood-api, from `Conexion_Front` @ `e62445b`)
**Plan:** `~/.claude/plans/en-el-rol-de-eager-token.md`

## Objective
In "Editar perfil", a volunteer (active role VOLUNTARIO) can change the cold chain and the operation zone (base location + coverage radius) besides names and phone. The profile's "Información de voluntario" section also shows Nombres, Apellidos and Celular.

## Problem / Why
Volunteer data was read-only and the API had no endpoint to change it after the request was approved.

## Scope / constraints
- User decisions (2026-10-27): only "Cadena de frío" and "Zona de operación" are editable; Vehículo, Placa and Capacidad stay read-only (verification is not affected). Zona = base location (map) + radius (km). Nombres/Apellidos/Celular shown in the profile section and grouped under "Información de voluntario" in the form. Volunteer view only; the donor view does not change.
- Conventional commits without Co-Authored-By trailers; tests ship with code; push/PR are the user's decision.
- Delivery strategy: `ask-on-risk`. Forecast ≈ 550 authored lines over two repos (≈ 200 API, ≈ 350 app); each repo stays one PR.

## Tasks
- [x] T1 (findfood-api) `PATCH /v1/voluntario/perfil` (`@Roles('VOLUNTARIO')`): `tiene_refrigeracion`, `ubicacion_base` (service area), `radio_cobertura_km` (1–100); vehicle/plate/capacity rejected (400); empty body 400; returns `/me`; e2e tests. Route: delegated writer (2+ non-trivial files).
- [x] T2 (app) service + mutation, volunteer schema + changes mapper, volunteer sections in `edit-profile.tsx`, names/phone rows in `account.tsx`, tests. Route: delegated writer (2+ non-trivial files).

## Acceptance criteria
- An approved volunteer changes cold chain, base location and radius; `/me` reflects it and the verification stays APROBADA.
- Sending vehicle type, plate or capacity to the new endpoint answers 400; a donor without the volunteer role gets 403.
- The donor's edit screen is unchanged; the volunteer's shows "Información de voluntario" and "Vehículo y zona" with only cold chain and zone editable.

## Checks
- API: `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e -- test/voluntario-perfil` (needs local DB).
- App: `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:render`.
- Native review: `gentle-ai` is blocked by the Windows Application Control policy in this session, so RDD status and risk assessment are unavailable → treated as `high`: writer self-verification + independent verification.

## Progress
- 2026-10-27: plan approved, branches created.
- 2026-10-27: T1 done in findfood-api, commit `a1fbfbb` `feat(voluntario): allow volunteers to update cold chain and operation zone` (delegated writer). RED 10/10 failed with 404; GREEN `npm run test:e2e -- test/voluntario-perfil` 10/10; `npm run lint` 0 errors (1 pre-existing warning); `npm run typecheck` clean; `npm test` 14 suites / 117 tests; `npm run build` ok. Full e2e suite not run.
- 2026-10-27: T2 implemented (delegated writer): `actualizarPerfilVoluntario` + `useActualizarPerfilVoluntarioMutation` (`PATCH /voluntario/perfil`, invalidates `/me`); `editVolunteerProfileSchema` (auth.ts, reusing `coverageRadiusKm` / `optionalBaseLocation` from `volunteer-request.ts`) + `volunteerProfileChanges` (mappers/profile.ts); shared `ColdChainChoice` / `OperationZoneFields` / `coverageKm` in `components/findfood/volunteer-zone.tsx` (registration form uses them, behavior unchanged); `edit-profile.tsx` picks the volunteer form only for active role VOLUNTARIO with `me.voluntario` (sections "Información de voluntario" and "Vehículo y zona", vehicle/plate/capacity read-only; `PATCH /me` then `PATCH /voluntario/perfil`, only changed fields, each answer stored as `/me`); Nombres/Apellidos/Celular rows in the profile's "Información de voluntario". RED observed: 21 new tests failed (missing exports / volunteer sections). GREEN: `npm test` 101 suites / 1706 tests passed; `npm run typecheck` exit 0; `npm run lint` exit 0, no findings; `npm run test:render` fails at a pre-existing assertion (`check-render.cjs` "Documento (frente)" vs the label "Foto del documento (frente) *"), reproduced on base `a6c63ce` in a throwaway worktree; the new volunteer-editor render assertions run before it and pass. Domain tests live in `src/domain/__tests__/volunteer-profile.test.ts` (colocated `*.test.ts` files were outside the authorized surface).

- 2026-10-27: T2 commit `52a733a`. Parent spot check: `npx jest profile-editors volunteer-profile` 31/31 passed; `npm run test:render` still fails only at `check-render.cjs:654` ("Documento (frente)"), the same failure as on base `a6c63ce` — recorded as a known pre-existing failure, not caused by this feature. T2 checked off with that caveat.

## Next step
Manual check in the app (volunteer: edit cold chain/zone; donor: unchanged screen). Push/PR for both branches is the user's decision; the stale `test:render` assertion can be fixed separately.
