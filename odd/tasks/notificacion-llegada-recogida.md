# Feature · notificacion-llegada-recogida

**Locator:** `odd/tasks/notificacion-llegada-recogida.md` in both repos (Engram mirror `odd/notificacion-llegada-recogida/tasks`: pending — Engram tools unavailable in the orchestrator session)
**Branch:** `feat/notificacion-llegada-recogida` (findfood-api, from `Conexion_Front` @ `33bcced`) · `feat/notificacion-llegada-recogida` (app, from `develop` @ `3bdfc71`)

## Objective
When the volunteer marks arrival at a pickup stop (`POST /v1/paradas/:id/llegada`, stop goes PENDIENTE → EN_SITIO), the donor of that donation receives a notification (inbox row + push) saying the volunteer is at the pickup point. Tapping it in the app opens the donor's live tracking of that donation.

## Problem / Why
The donor is only told when the donation is accepted and when it was already picked up; nothing warns them that the volunteer is waiting at the door.

## Scope / constraints
- Recipient: the donor of the donation (`donacion.donante_usuario_id`). Only RECOGIDA stops; ENTREGA (warehouse) stops notify nobody.
- Only on the real PENDIENTE → EN_SITIO transition; the idempotent repeat of `llegada` does not notify again.
- New notification type `VOLUNTARIO_EN_SITIO` seeded by a new SQL migration (schema rule: new migration, never `prisma migrate`). Applying it to the real Supabase project (`supabase db push`) is a remote operation left to the user.
- Bank fleet routes (`flota_banco`) name "El banco de alimentos" as the collector, as `ASIGNACION_ACEPTADA` already does.
- Conventional commits without Co-Authored-By trailers; tests ship with code; push/PR are the user's decision.
- Delivery strategy: `ask-on-risk`. Forecast ≈ 120 authored lines (≈ 100 API, ≈ 15 app); each repo stays one PR.

## Tasks
- [x] T1 (findfood-api) migration seeding `VOLUNTARIO_EN_SITIO`; add it to `CodigoNotificacion`; enqueue it in `RuteoService.llegada` for RECOGIDA stops; e2e coverage (notified once, not on repeat, not on ENTREGA). Route: delegated writer (2+ non-trivial files). Commit `4db2b84`. E2E run still pending (local DB unavailable).
- [ ] T2 (app) `VOLUNTARIO_EN_SITIO` opens `/donante/seguimiento?id=<donacion>` in `notification-routes.ts`; table test. Route: inline (one mapping line + one test row, mechanical).

## Acceptance criteria
- After `llegada` on a pickup stop, the donor's `/v1/me/notificaciones` has one `VOLUNTARIO_EN_SITIO` row with the donation id, naming the volunteer.
- Repeating `llegada` does not add a second row; `llegada` on the delivery stop adds none.
- In the app, the notification opens the donor's tracking screen of that donation, or the alerts tab without a donation id.

## Checks
- API: `npm run lint`, `npm run typecheck`, `npm test`, e2e of the touched suite (needs local DB).
- App: `npm run lint`, `npm run typecheck`, `npx jest notification-routes`.

## Progress
- 2026-11-07: explored; branches created; feature document created.
- 2026-11-07: T1 done in commit `4db2b84`. `llegada` enqueues `VOLUNTARIO_EN_SITIO` only after the real PENDIENTE → EN_SITIO update on a RECOGIDA stop. The donor comes from `DonacionesService.bloquear`, the same helper `confirmarRecogida` uses. The name is `usuario.nombres`: `exigirEjecutor` guarantees the caller is the route's volunteer, so no extra query is needed. Fleet routes use 'El banco de alimentos'. Migration `20261107000000_notificacion_voluntario_en_sitio.sql` seeds the type (`ON CONFLICT (codigo) DO NOTHING`, via `uq_tipo_notificacion_codigo`). E2E in `test/flujo-completo.e2e-spec.ts` checks one row with `donacion_id` and the body 'Vol está en el punto de recogida de tu donación.', no second row after a repeated `llegada`, and none after the ENTREGA `llegada`.
  - RED/GREEN: not observed. The local DB is down (`npm run db:local` → docker npipe `dockerDesktopLinuxEngine` not found; podman not installed), and `RuteoService` has no unit spec that could stand in for the e2e.
  - Checks: `npm run lint` exit 0 with 2 warnings, both pre-existing (base has the same 2) · `npm run typecheck` exit 0 · `npm test` 14 suites / 117 tests passed · `npm run test:e2e -- test/flujo-completo` blocked (`ECONNREFUSED 127.0.0.1:54329`).
  - Remote: the real Supabase project needs `supabase db push` for this migration (left to the user). Until then `llegada` on a pickup stop fails with "Tipo de notificación VOLUNTARIO_EN_SITIO no existe".

## Next step
Run `npm run db:local` + `npm run test:e2e -- test/flujo-completo` to observe T1 green; then T2.
