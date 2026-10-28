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
- [ ] T2 (app) service + mutation, volunteer schema + changes mapper, volunteer sections in `edit-profile.tsx`, names/phone rows in `account.tsx`, tests. Route: delegated writer (2+ non-trivial files).

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
- 2026-10-27: T1 done (delegated writer). `ActualizarVoluntarioDto` + `VoluntarioService.actualizarPerfil` + `PATCH /v1/voluntario/perfil`; empty body → `BadRequestException([...])` → 400 `validacion`; `ubicacion_base` via `$executeRaw` + `sqlPunto()` in the same transaction as the Prisma update; returns `IdentidadService.perfil`. New suite `test/voluntario-perfil.e2e-spec.ts` (real Bogotá service zone, own zone in Sibaté 4.49,-74.26, volunteers left unavailable so they never cross-match). RED observed: 10/10 failed with 404. GREEN: `npm run test:e2e -- test/voluntario-perfil` 10/10 passed; `npm run lint` 0 errors (1 pre-existing warning in `rutas-dinamicas.service.ts`); `npm run typecheck` clean; `npm test` 14 suites / 117 tests passed; `npm run build` ok. Work-unit commit `feat(voluntario): allow volunteers to update cold chain and operation zone`. Full e2e suite not run (only the new file).

## Next step
T2.
