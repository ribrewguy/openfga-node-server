# Code Organization Policy

This policy defines how source modules in this repository are arranged
so future work follows the same shape without rediscovering it. Each
section codifies a pattern already established in the codebase and
verified by tests at the time of its addition.

The policy intentionally limits itself to *organization* — the
physical layout of files, the composition of subsystems, and the
seams between modules. It does not duplicate runtime behavior, wire
contracts, or feature scope. Those live in the PRD and feature
specifications.

---

## 1. Route Organization (Hono)

### 1.1 Sub-app composition

HTTP routes are split into one Hono sub-app per resource family.
Sub-apps export a `Hono` instance and are composed by
`src/routes/index.ts` via `app.route('/', subApp)`.

* The composing file (`src/routes/index.ts`) contains the
  middleware chain and the `app.route()` calls. No route handlers
  live in this file.
* Each sub-app file owns one resource family (e.g. `stores.ts`,
  `tuples.ts`, `evaluation.ts`).
* Resource families follow the wire contract's natural boundaries
  (e.g. all `/stores/:storeId/check`, `/stores/:storeId/batch-check`,
  `/stores/:storeId/expand`, `/stores/:storeId/list-objects`, and
  `/stores/:storeId/list-users` belong to one `evaluation.ts`
  because they share the OpenFGA evaluation surface).

### 1.2 Full-path declarations

Sub-apps declare full paths (e.g. `'/stores/:storeId/check'`), NOT
basePath prefixes.

* Mount with `app.route('/', subApp)` — the literal `'/'` root.
* `app.basePath()` is not used to split URL strings across files.
* This rule makes every OpenFGA wire URL grep-findable in exactly
  one place (the sub-app file). Cross-file URL audits are a smell
  this rule prevents.

### 1.3 Middleware composition belongs at the top level

All `app.use()` calls live in `src/routes/index.ts`'s `buildApp()`
function, in the order defined by the system's wire-level contract.
Sub-apps do not register `use()` middleware.

* Path-scoped middleware (e.g. `app.use('/stores/:storeId/*',
  requireStore())`) registered at the top level correctly applies to
  routes declared in any sub-app — Hono's route-pattern semantics
  fire parent middleware before sub-app handlers regardless of
  where the handler is declared.
* Per-route validation middleware (e.g.
  `validate('json', CheckBody)`) is the only middleware allowed
  inside a sub-app handler chain, since it is route-specific, not
  app-wide.

### 1.4 Helpers belong in `_helpers/`

Cross-resource helpers (cursor encoders, content-type detection,
shared overlays) live in `src/routes/_helpers/*.ts`. Resource-
specific helpers used by exactly one sub-app may co-locate in that
sub-app file at the author's discretion.

* The `_helpers/` directory name uses a leading underscore so it
  sorts before the resource files in any directory listing.
* Helpers must not import sub-apps. The dependency direction is
  always `sub-app → helpers`, never the reverse.

### 1.5 File-size guidance

Sub-app files should stay ≤200 lines. The composing
`src/routes/index.ts` should stay ≤200 lines too — it contains the
middleware chain and the composition only.

* The 200-line bound is a guideline, not a hard rule; passing it
  intentionally is fine when a single resource has a complex
  handler that benefits from co-location.
* When a sub-app crosses 300 lines, split it along a sub-boundary
  (e.g. `tuples-write.ts` and `tuples-read.ts`) rather than letting
  it grow further.

### 1.6 Test layout for routes

Route behavior is exercised by integration tests under
`tests/integration/*.test.ts` plus per-handler unit tests under
`tests/unit/*-route.test.ts`. Tests address the routes through
`buildApp()` — they do not import sub-apps directly.

* The `buildApp()` signature is the public surface; refactors
  inside `src/routes/` are not test-visible as long as `buildApp()`
  returns an equivalent Hono app.
* This rule makes route refactors zero-test-touch when behavior is
  preserved (verified in openfga-dk3).

---

## 2. Future Sections

This document grows as patterns are codified. Anticipated future
sections:

* **Configuration boundary** — `src/config*.ts` as the single typed
  config surface; no `process.env` reads in application code outside
  this module.
* **Storage layer** — `TupleStore` interface, singleton lifecycle
  via `getDb()`, `resetDb()` for tests, dialect-aware factories.
* **Test isolation** — side-effect-free modules
  (`config-schema.ts`, `config-env-overrides.ts`) vs side-effectful
  modules (`config.ts`); `reloadConfigForTests()` for env-driven
  test scenarios.
* **Middleware factories** — `factory(config) → MiddlewareHandler`
  signature so tests construct middleware with explicit args rather
  than reading from the live `config` Proxy.

Add a section here when the corresponding pattern is delivered and
verified by tests.
