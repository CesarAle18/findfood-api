# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The `findfood` project, scaffolded from [next-forge](https://github.com/vercel/next-forge) 6.0.2 — a Turborepo template for Next.js SaaS apps. Apps in `apps/` are independently deployable; shared code in `packages/` is imported as `@repo/<name>`.

The root `package.json` is still the *template's own* npm package (`"name": "next-forge"`, plus `bin`, `files`, `publishConfig`, `tsup.config.ts`, `release` script). Those fields package the next-forge CLI, not this project — ignore them, and don't wire anything to them.

## Scope: this repo is an API only

**`apps/api` is the only app in scope.** The template ships seven apps; the rest (`web`, `app`, `docs`, `email`, `studio`, `storybook`) are unused scaffolding that came with the clone.

What follows from that:

- Build features in `apps/api` and in the `packages/*` it consumes. Don't add UI, pages, or components to `apps/app` or `apps/web` unless the user explicitly redirects the scope.
- `DATABASE_URL` and the API's own integrations (Stripe webhooks, Svix, Arcjet, Clerk token verification for authenticated endpoints) are the credentials that matter. The marketing-site and Storybook problems documented below are **out of scope** — they are recorded so nobody mistakes them for regressions, not as work to pick up.
- `npm run dev -- --filter api` is the normal dev command; a bare `npm run dev` would start six apps you don't need.
- Deployment is a single Vercel project rooted at `apps/api`, not the three-project split the upstream docs describe.

## This clone runs on npm, not bun

Upstream next-forge is developed against bun. This clone was converted to npm, which required changes you must not undo:

- **`.npmrc` sets `legacy-peer-deps=true`** — `openai@4.x` declares a `peerOptional zod@^3`, while every workspace here is on zod 4. npm's strict resolver refuses to install without this.
- **Root `overrides` pins `react` and `react-dom` to `19.2.4`** — `packages/ai` depends on `streamdown` but declares no `react-dom`, so npm resolved that peer to `react-dom@19.3.0`, which then demanded `react ^19.3.0`. The pin keeps exactly one copy of each.
- **14 scripts were de-bun-ified** — root scripts went `bunx` → `npx`; `apps/{app,web,api}` went `bun --bun next …` → `next …`. Without this, `npm run dev` exits 127 with `bun: command not found`.

Consequences for you:

- Upstream docs and `skills/next-forge/SKILL.md` say `bun run <x>`. Use `npm run <x>` here.
- Never reintroduce `bun`/`bunx` into a `package.json` script.
- **`apps/storybook` does not work under npm** and is not worth debugging. Two independent causes: (1) Storybook builds an extensionless absolute path (`node_modules/@storybook/nextjs/preset`) and imports it as ESM — bun's resolver tolerates that, Node's does not; (2) the workspace is itself named `storybook`, so `node_modules/storybook` symlinks to `apps/storybook` (v0.1.0) and shadows the real `storybook@10.6.0`, which ends up nested in `apps/storybook/node_modules/`.

## Commands

```sh
npm run dev -- --filter api        # the app in scope (turbo passthrough)
npm run build                      # turbo build; `test` is a dependsOn, so tests gate builds
npm run check                      # ultracite (Biome) lint
npm run fix                        # ultracite autofix
npm run test                       # turbo test
npm run test --workspace=app -- __tests__/sign-in.test.tsx   # a single test file
npm run typecheck --workspace=api  # tsc --noEmit, per workspace
npm run migrate                    # prisma format + generate + migrate dev
npm run db:push                    # prisma format + generate + db push
```

Only `apps/api` and `apps/app` have tests (vitest, `vitest.config.mts`, `NODE_ENV=test`). Both pass.

| App | Port | Scope | Notes |
|-----|------|-------|-------|
| `api` | 3002 | **in scope** | Webhooks/cron; needs `DATABASE_URL`; `dev` also runs the Stripe CLI |
| `studio` | 3005 | useful | Prisma Studio — handy for inspecting the API's database |
| `app` | 3000 | unused | Authenticated SaaS app; needs `DATABASE_URL` |
| `web` | 3001 | unused | Marketing site; cannot render without `BASEHUB_TOKEN` |
| `email` | 3003 | unused | React Email preview; the one app that runs with no credentials |
| `docs` | 3004 | unused | Mintlify |
| `storybook` | 6006 | unused | Broken under npm |

## The API surface today

Four routes exist, all under `apps/api/app/`. Verified behaviour with the placeholder database (no Postgres running):

| Route | Method | Status | Notes |
|-------|--------|--------|-------|
| `/health` | GET | 200 `OK` | A one-line `new Response("OK")`; touches nothing |
| `/cron/keep-alive` | GET | 500 | `ECONNREFUSED` — queries the database |
| `/webhooks/auth` | POST | 405 on GET | Clerk events via Svix |
| `/webhooks/payments` | POST | 405 on GET | Stripe events |

So the API boots and serves in 2.6s; the only failure is the route that needs a live database. That is the baseline to build on.

## Environment variables

Two layers: each package owns a `keys.ts` that validates its own vars with zod via `@t3-oss/env-nextjs`; each app's `env.ts` composes those with `extends: [cms(), core(), observability(), …]`. Add a var to the package that owns the integration, not to the app. `SKIP_ENV_VALIDATION=true` bypasses all of it.

Two traps that cost real debugging time:

- **An empty string is not `undefined`.** `BETTERSTACK_URL=""` fails `z.url().optional()` and takes down the whole app at config load. The generated `.env.local` files ship every unused var as `=""`. Comment them out rather than leaving them empty — `apps/web/.env.local` has already been done this way.
- **"All integrations besides the database are optional" is not true.** The zod schemas mark them `.optional()`, but the SDKs throw anyway — `@clerk/nextjs` throws on a missing `publishableKey`, BaseHub throws `Token not found`. Expect the same from any other SDK here: treat `.optional()` in a `keys.ts` as a claim to verify, not a guarantee.

`DATABASE_URL` is the one genuinely required var — `z.url()` with no `.optional()` in `packages/database/keys.ts`, and `apps/api/env.ts` extends `database()`. Note the distinction: the API needs a **syntactically valid** URL to boot at all (env validation), but only needs a **reachable** Postgres for routes that query it. It lives in `packages/database/.env`, separate from the apps' `.env.local`.

Both `packages/database/.env` and `apps/api/.env.local` currently hold a commented **placeholder** URL (`postgresql://placeholder:…@localhost:5432/findfood`) with no database behind it. Replace it with a real one; don't assume a working database because the var is set.

Out-of-scope leftovers, recorded so they aren't mistaken for bugs: every `apps/web` route 500s without a real `BASEHUB_TOKEN`, because its root layout (`apps/web/app/[locale]/layout.tsx`) imports `@repo/cms`; and `apps/web/.env.local` holds **fake** Clerk keys (`pk_test_`/`sk_test_`, valid format, invented values) so its middleware loads locally.

## Architecture patterns

- **`next.config.ts` is a composition of package-provided higher-order functions** — a base `config` from `@repo/next-config`, then `withToolbar`, `withLogging`, `withSentry`, `withAnalyzer`, `withCMS`. Extend configuration by adding a wrapper, typically exported from the package that owns the concern.
- **Middleware lives in `proxy.ts`, not `middleware.ts`** (the Next 16 rename). **`apps/api` has no `proxy.ts` at all** — no Clerk middleware, no i18n, no Arcjet in its request path; its routes are reached directly. Webhook routes authenticate themselves from the request signature instead (Svix for Clerk events, Stripe for payments). In `web`/`app`, by contrast, Clerk's `authMiddleware` is the outermost wrapper with i18n and Arcjet composed inside it via `createNEMO` from `@rescale/nemo`, so a Clerk failure there breaks every matched route. If you add middleware to the API, you are introducing that file, not editing it.
- **Prisma** generates its client into `packages/database/generated` and is configured by `packages/database/prisma.config.ts`. `DATABASE_URL` lives in `packages/database/.env`, separate from the apps' `.env.local`.
- `page.tsx` and `layout.tsx` are server components; client interactivity goes in separate `'use client'` files.
- `turbo.json` declares `build` as `dependsOn: ["^build", "test"]` — a failing test fails the build.

## Project-specific state

- **Not a git repository.** `next-forge init` skipped git initialization.
- `skills/next-forge/` is the template's own bundled skill, with `references/{architecture,packages,customization,setup}.md`. It is accurate about structure and ports, but written for bun, and wrong about optional integrations (above).
- `.cursorrules.example` is an unfilled placeholder template — no rules to honor.
- npm 11 blocked 13 dependency install scripts (Prisma, esbuild, sharp, `@sentry/cli`, Clerk, core-js) under its `allowScripts` gate. Nothing needed them so far: `npx prisma generate` works and esbuild's linux-x64 binary arrived as an optional dependency. If a native binary turns up missing, `npm install-scripts approve <pkg>` is the fix — ask the user first, since it executes third-party code.
