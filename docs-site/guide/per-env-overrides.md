# Per-Environment Overrides

c12 supports top-level `$development`, `$production`, and `$test`
blocks. The block matching `NODE_ENV` at startup is merged on top of
the base config:

```yaml
db:
  url: postgresql://postgres@localhost/openfga
log:
  level: info

$development:
  log:
    level: debug

$production:
  log:
    level: info
  db:
    pool:
      connectionTimeoutMs: 5000
      statementTimeoutMs: 30000

$test:
  db:
    url: ':memory:'
```

## Selection rule

The selector is `NODE_ENV` exactly:

| `NODE_ENV` value | Block applied |
|---|---|
| `development` | `$development` |
| `production` | `$production` |
| `test` | `$test` |
| anything else / unset | no block applied — base config only |

A typo (`NODE_ENV=prod`) silently selects nothing. Production
deployments should ship with `NODE_ENV=production` set explicitly.

## Merge semantics

`$<env>` blocks are deep-merged onto the base. For each path:

- **Scalars** (string / number / boolean) — replaced by the override.
- **Objects** — recursively merged. Keys present in both are merged;
  keys only in the override are added; keys only in the base are
  preserved.
- **Arrays** — replaced wholesale. The override array does NOT append
  to the base. To customize a single array element per environment,
  redeclare the whole array in the override.

## Common patterns

### Verbose dev, quiet prod

```yaml
log:
  level: info

$development:
  log:
    level: debug
```

### Real database in dev, fixture in CI

```yaml
db:
  url: postgresql://postgres@localhost/openfga

$test:
  db:
    url: 'file::memory:?cache=shared'
```

### Tight production pool

```yaml
db:
  pool:
    max: 10

$production:
  db:
    pool:
      max: 50
      connectionTimeoutMs: 5000
      statementTimeoutMs: 30000
```

### Per-env auth modes

```yaml
auth:
  mode: none

$production:
  auth:
    mode: oidc
    oidc:
      issuer: https://auth.example.com
      audience: openfga-server
```

This pattern keeps local development unauthenticated while production
runs through the real IdP. Combine with [Pre-Shared Keys](/guide/auth-preshared)
for staging.

## Pitfalls

- **Array replacement, not append.** Adding one extra
  `auth.presharedKeys` entry in `$production` requires redeclaring the
  full list, not just the new key.
- **`NODE_ENV` mistyped silently skips the block.** Use
  `NODE_ENV=production` exactly. The server doesn't warn when no
  override block matches because "no override" is the legitimate state
  for environments you haven't customized.
- **Env vars still beat the override.** `OPENFGA_DB_URL` in the
  environment overrides whichever `db.url` the `$<env>` block would
  have set. This is by design — env vars are the operator's final
  say.

## See also

- [Configuration File](/guide/configuration) — full precedence order
- [Environment Variables](/guide/env-vars) — what env vars override
