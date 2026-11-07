# Feature · sincronizacion-tiempo-real (API)

**Locator:** `odd/tasks/sincronizacion-tiempo-real.md` (Engram mirror `odd/sincronizacion-tiempo-real/tasks`: pending — Engram tools unavailable in the orchestrator session)
**Branch:** `feat/sincronizacion-tiempo-real` (from `Conexion_Front` @ `c0ab0c0`)
**Sibling:** `findfood-app-mobile` → `odd/tasks/sincronizacion-tiempo-real.md` (branch `feat/sincronizacion-tiempo-real` from `develop` @ `1b36ce2`)
**Plan:** `~/.claude/plans/pasted-content-id-a4be-necesito-que-compiled-wall.md`

## Objective
Mobile users (DONANTE, VOLUNTARIO) see changes made by other users or processes (staff in the web panel, other volunteers, crons) without leaving the screen, signing out or reopening the app.

## Problem / Why
The app only learns about other users' changes through a foreground push (up to ~60 s late, sent by a 1-min cron), a few state-limited polls, returning to the foreground, or mounting a screen with data older than 30 s. Several events notify nobody (staff cancel/reassign, failed pickup, offer taken by another volunteer, incidents).

## Approach
Reuse the existing Supabase Realtime private broadcast design (decision record 05; `fn_donacion_realtime` → `banco:donaciones`, `ruta:<uuid>` GPS). Add a per-user private topic `usuario:<uuid>`, event `sync`, emitted from AFTER triggers through `fn_rt_sincronizar` (per-transaction dedupe on `(uid, entidad, id)`). Payload is an invalidation hint only; the app re-fetches over REST, where roles and ownership are enforced.

Payload contract v1: `{ v: 1, entidad: 'donacion'|'asignacion'|'parada'|'ruta'|'notificacion'|'cuenta', id?, donacion_id?, ruta_id?, asignacion_id?, tipo? }` — no business data, no `estado`, donors never receive other donors' ids.

## Scope / constraints
- User decisions (2026-11-07): scope is mobile + API only (web panel untouched, must keep working: `banco:donaciones`/`donacion_estado`, `ruta:<id>`, private channels, `fn_rt_es_personal`); add all missing notices N1–N7.
- Triggers filtered by column (`UPDATE OF … WHEN … IS DISTINCT FROM …`); never fire on `voluntario.ultima_ubicacion*`, `usuario.ultimo_acceso_at`, `notificacion.estado_envio`/`leida_at`, `updated_at`, ETA/order columns.
- Notification templates in Spanish (product language), consistent with the existing `tipo_notificacion` catalog; code, comments and docs follow repo conventions.
- Conventional commits without Co-Authored-By trailers; tests ship with code; stage only task files (never `.atl/`, `docs/historias-tecnicas-app-movil.md`, `docs/tareas-integracion-app-movil.md`).
- Out of scope (documented follow-ups): web panel migration to `usuario:<uuid>`; ADMIN notice for volunteer applications; suspension/reactivation notice; inventory/alerts events (staff-only, web).

## Acceptance criteria
- A user can read only `usuario:<own uid>` messages, only while ACTIVO and not deleted; clients cannot insert on user topics.
- Every state change in donacion/asignacion/parada_ruta/ruta, every new notificacion, and every account/role/verification change produces one `sync` message per affected user per transaction; location pings, outbox drains and guard touches produce none.
- `banco:donaciones` keeps being emitted unchanged.
- N1–N7 notices are created (inbox + push outbox) exactly once per event, without duplicating existing notices.

## Checks
`npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e -- test/sincronizacion` + touched suites (needs `npm run db:local:reiniciar`); full e2e at closure vs. the API-0 baseline.

## Delivery
- Forecast ~1,150 authored changed lines (exceeds 400). Strategy `ask-on-risk`; chain strategy asked before any PR is created (commits are identical either way). Push/PR/merge are the user's decision.
- RDD: on (global). Review boundary starts at the branch point `c0ab0c0`.

## Tasks
| ID | Task | Route | Status | Commit | Review |
|---|---|---|---|---|---|
| API-0 | Baseline: lint, typecheck, unit, full e2e; record pre-existing failures | delegated verification worker + parent e2e run | [x] | — (no code) | n/a |
| API-1 | Channel + authorization migration (`fn_rt_usuario_id`, `fn_rt_es_usuario_activo`, `pol_rt_usuario_leer`, `fn_rt_sincronizar`), `test/sincronizacion.e2e-spec.ts` policy cases, `docs/arquitectura.md` §9.4 + record 05 addendum | delegated writer (2+ non-trivial files) | [x] | `b4cc0c6` | medium · slice_budget_reached (452 lines) · native review unavailable (see Review) |
| API-2 | Flow triggers (`donacion`, `asignacion`, `parada_ruta`, `ruta`) + e2e flow cases | delegated writer | [x] | `4e7a0d3` | medium · slice_budget_reached (983 lines) · native review unavailable |
| API-3 | Account + inbox triggers (`notificacion`, `usuario`, `usuario_rol`, `voluntario`) + negative/positive e2e | delegated writer | [x] | `40a77ed` | medium · slice_budget_reached (1,459 lines) · native review unavailable |
| API-4 | Missing notices N1–N7 (catalog migration, `encolar` calls, unit + e2e, docs); read-only web inbox check for unknown `tipo` | delegated writer | [ ] | — | — |

## Progress
- 2026-11-07: plan approved; branch created; feature document created (`684f9cb`).
- 2026-11-07: API-0 baseline @ `c0ab0c0`: `npm run lint` exit 0 (2 pre-existing warnings: unused `Prisma` import in `src/modulos/asignacion/rutas-dinamicas.service.ts:2`, `.sort()` without compare in `test/asignacion.e2e-spec.ts:306`); `npm run typecheck` exit 0; `npm test` 16/16 suites, 132/132; `npm run db:local:reiniciar` + `npm run test:e2e` 12/12 suites, 126/126 (needs the Docker Desktop engine running). No pre-existing failures.

- 2026-11-07: API-1 `b4cc0c6` (writer; RED: 7/8 failing on missing `fn_rt_sincronizar`/`fn_rt_usuario_id`; the client-INSERT denial case passed before the migration and stays as a regression guard). Evidence: lint exit 0 (2 known warnings), typecheck exit 0, `npm test` 132/132, `test:e2e -- test/sincronizacion test/seguimiento test/flujo-completo` 36/36, `test/auth` 26/26; parent re-ran `test/sincronizacion` 8/8. Decisions: dedupe GUC `findfood.rt_sincronizados` (jsonb keyed by `[uid, entidad, id]`); `fn_rt_sincronizar` prepends `v: 1`; no grants on `fn_rt_sincronizar`; docs in `docs/arquitectura.md` §9.4 (Realtime is §9 in the doc, §19 in the DDL). Open: `fn_rt_es_usuario_activo` does not require `NOT debe_cambiar_password` (REST still enforces it).
- 2026-11-07: API-2 `4e7a0d3` (writer; RED: 7 new flow cases failing on message assertions with correct HTTP statuses). Evidence: lint exit 0 (2 known warnings), typecheck exit 0, `npm test` 132/132, full `test:e2e` 13/13 suites, 141/141; parent re-ran `test/sincronizacion` 15/15. Accepted widening: `parada_ruta` also notifies donors whose pickup is COMPLETADA while their donation is still ASIGNADA/EN_RECOLECCION/EN_TRANSITO (their live-position window flips when another stop closes); each donor still receives only its own donation id. Observed extra emissions: losing volunteers get `donacion` + `asignacion` on accept; `trazar()` updates `geometria` after the accept transaction → a second `ruta` message; changing only `asignacion.ruta_id` emits nothing (same transaction already emits `ruta`/`parada`).
- 2026-11-07: API-3 `40a77ed` (writer; RED: 5 positive cases failing with empty message arrays and correct HTTP statuses; 2 negative cases passed before the migration and stay as guards). Evidence: lint exit 0 (2 known warnings), typecheck exit 0, `npm test` 132/132, full `test:e2e` 13/13 suites, 148/148; parent re-ran `test/sincronizacion` 22/22. Deviation: `notificacion` has no `tipo` column; `tipo` comes from `tipo_notificacion.codigo` via `tipo_notificacion_id` (same code the REST inbox returns). Test helper `ctx.solicitudVoluntario()` split out of `ctx.voluntario()` (behavior unchanged). Other `cuenta` emitters (own user only, deduped): signup role insert, admin-created account, email confirmation, password change, `PATCH /admin/usuarios/:id/estado`, verification rejection, `PUT /voluntario/disponibilidad` with no slots.

## Review
- gentle-ai 4.0.0: the `intended_untracked_selection` collect submission (`--contract … --projection=workspace --intended-untracked-selection=…`) drops `--base-ref/--committed-only`, so the re-entry targets the uncommitted workspace instead of the committed slice (observed in both repos). User decision (2026-11-07): continue without reporting; affected slices record native review as unavailable and follow the RDD-off tier path (assess tier → writer self-verification; independent verifier for high).

## Next step
API-4 missing notices N1–N7.
