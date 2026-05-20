# openfga-node-server

[![codecov](https://codecov.io/gh/ribrewguy/openfga-node-server/graph/badge.svg)](https://codecov.io/gh/ribrewguy/openfga-node-server)

**NodeFGA** — fine-grained, relationship-based authorization for Node.
Built on the OpenFGA authorization-model semantics; runs anywhere Node
runs.

📖 **Full documentation:** [ribrewguy.github.io/openfga-node-server](https://ribrewguy.github.io/openfga-node-server/)

The published docs cover configuration, authentication modes, observability,
deployment runbooks, recipes, and the migration path to upstream OpenFGA.
This README is intentionally short — it's a starting point, not a
duplicate of the docs site.

## Status

Prototype. The OpenFGA REST surface this project implements is wired
end-to-end and the SDK conformance suite passes against it. See
[bd](https://github.com/steveasleep/beads) (`bd list`) for the live work
queue.

## Quick start

```sh
pnpm install

# Configure (file is canonical; env vars override file values).
cp openfga.config.example.yaml openfga.config.yaml
$EDITOR openfga.config.yaml         # set db.url at minimum

# Apply schema.
pnpm migrate up

# Boot.
pnpm dev

# In another shell — load the example authorization model.
pnpm load-model tests/fixtures/github.fga
```

The server listens on `:8080`. Liveness check:

```sh
curl http://localhost:8080/health
# {"status":"ok"}
```

For everything else — full configuration surface, auth setup, OpenTelemetry
wiring, production deployment runbooks, worked-example recipes — see the
[documentation site](https://ribrewguy.github.io/openfga-node-server/).

## Repository layout

- `src/` — server source (routes, evaluator, storage, middleware).
- `tests/` — unit + integration tests, SDK conformance suite.
- `migrations/` — Kysely-typed schema migrations.
- `docs/` — internal specs (PRD, architecture, feature specs, policies). Not
  shipped to the docs site.
- `docs-site/` — published documentation (VitePress, deployed to GitHub
  Pages by `.github/workflows/docs.yml`).

## Development

```sh
pnpm verify             # lint, typecheck, build, tests + coverage
pnpm verify:fast        # lint, typecheck, build, unit tests
pnpm test               # unit + integration
pnpm docs:dev           # local docs preview (http://localhost:5173)
```

Workflow conventions — branches, commits, beads, code reviews — live under
[`docs/policies/`](docs/policies/). `CLAUDE.md` is the agent-facing index
into those policies.

## License

MIT.
