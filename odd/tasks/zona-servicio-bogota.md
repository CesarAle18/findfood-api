# Feature · zona-servicio-bogota

**Locator:** `odd/tasks/zona-servicio-bogota.md` in both repos (Engram mirror `odd/zona-servicio-bogota/tasks`: pending — Engram tools unavailable in the orchestrator session)
**Branch:** `feat/zona-servicio-bogota` (app, from `develop` @ `83707ae`) · `feat/zona-servicio-bogota` (findfood-api, from `Conexion_Front`)
**Plan:** `~/.claude/plans/necesito-tambien-que-modifiques-composed-giraffe.md`

## Objective
Addresses and saved points are limited to Bogotá and its neighbouring municipalities (Soacha, Chía, Cajicá, Cota, Funza, Mosquera, Madrid, La Calera, Sibaté, Tocancipá…).

## Problem / Why
Google searches are only restricted to Colombia (a 50 km bias around Bogotá), so suggestions and geocoded points from other cities appear, and the API accepts any valid lat/lng as a pickup point or volunteer base.

## Scope / constraints
- User decisions (2026-10-24): restrict searches AND reject points outside the area (app + API); the map itself still pans freely. Area = Bogotá + neighbouring municipalities.
- Service area rectangle (same numbers in both repos): south 4.44, north 5.00, west -74.30, east -73.95.
- API changes also affect the web front (same `/geo/*` endpoints and DTOs).
- Conventional commits without Co-Authored-By trailers; tests ship with code; push/PR are the user's decision.

## Tasks
- [ ] T1 (findfood-api) Service area constant + validator; Google autocomplete `locationRestriction.rectangle`; details/geocode filtered to the area; reverse geocode outside the area skips Google; DTO validation for `ubicacion_recogida` and `ubicacion_base`; unit + e2e tests. Route: delegated writer (2+ non-trivial files).
- [ ] T2 (app) `SERVICE_AREA` + `isInServiceArea`; phone geocoder results outside the area are "not found"; donation draft and volunteer request reject points outside the area; NOT_FOUND text mentions Bogotá; tests. Route: delegated writer (2+ non-trivial files).

## Acceptance criteria
- Autocomplete only suggests places inside the rectangle; geocoding an address outside answers 404; points outside are rejected with 400 by the API and with a field error by the app; a point in Chía is accepted.

## Checks
- API: `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e` (geo, donaciones, voluntario; needs local DB).
- App: `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:render`.

## Progress
- Pre-work (not part of this feature): app `develop` got `beb0d57` (light map), `88802e3` (native pin), `83707ae` (search icon).
- T1 (findfood-api) 2026-10-24: committed `9ce3572` (feat(geo): limit address search and saved points to Bogotá's service area). Left unchecked until e2e runs.
  - Route: delegated writer (2+ non-trivial files). The new tests failed first (5 google.spec failures plus a geo.spec compile error) and pass after the change.
  - Scope: optional `ZONA_SERVICIO` env var (`sur,oeste,norte,este`), validated at startup, defaulting to `ZONA_SERVICIO_BOGOTA` and read lazily in `src/comun/geo.ts`. Autocomplete uses `locationRestriction.rectangle`. Place details and forward geocoding drop results outside the area (`bounds` is sent). Reverse geocoding of an outside point skips Google. `/geo/lugares/:id` for a place outside the area returns 404. The autocomplete `lat`/`lng` params are deprecated and ignored. `@DentroDeZonaServicio()` on `ubicacion_recogida` / `ubicacion_base` returns 400.
  - Decision (user, option B): the e2e env (`test/configuracion/entorno.ts`) widens the area to Colombia (`-4.3,-79.1,13.5,-66.8`) so the per-city suite isolation keeps working. `test/zona-servicio.e2e-spec.ts` sets it back to Bogotá for its own run.
  - Checks: `npm run lint` OK (one existing warning in rutas-dinamicas.service.ts), `npm run typecheck` OK, `npm test` 117/117 OK. e2e has not run: Docker Desktop is not running (`ECONNREFUSED 127.0.0.1:54329`).
- Next: start Docker, run `npm run db:local` and the full `npm run test:e2e`, and check off T1 if it passes. Then T2 (app).
- RDD: `gentle-ai review assess --base-ref 6e6d392 --committed-only` (untracked excluded) gave medium, `review_due` (`slice_budget_reached`, 618 lines). The preflight STATUS asked for an intended-untracked selection, and submitting an empty selection was refused (`invalid_request`). Native review is unavailable, pending the user's decision.
- App T2 (`b1da8af`): assessed medium, `under_budget`, so its review is still pending in the slice.
