# Structured Logging

NodeFGA logs with [pino](https://github.com/pinojs/pino):
JSON in production, pretty-printed in development. Every log entry
is single-line JSON — `jq`, log shippers, and the OTel collector all
parse them directly.

## Configuration

```yaml
log:
  level: info     # trace | debug | info | warn | error | fatal | silent
```

Or:

```sh
OPENFGA_LOG_LEVEL=info
```

Default is `info`. `trace` is firehose-noisy; `silent` disables
logging entirely (useful for some test scenarios but not for
production).

## Output shape

Every log entry contains at least:

```json
{
  "level": 30,
  "time": 1714589041234,
  "pid": 12345,
  "hostname": "openfga-prod-1",
  "msg": "request_completed",
  "reqId": "01HXYZ…",
  "method": "POST",
  "path": "/stores/01HABC.../check",
  "status": 200,
  "durationMs": 4.2
}
```

`level` is the numeric pino level (`20`=debug, `30`=info, `40`=warn,
`50`=error, `60`=fatal). `time` is epoch-ms.

## Pretty-printed dev output

When the process is attached to a TTY (typically `pnpm dev`), pino
auto-routes through `pino-pretty` if it's installed in `node_modules`.
The repo includes it as a dev dependency, so `pnpm dev` shows a
colorized, human-readable stream:

```
[15:23:04.123] INFO: request_completed
    reqId: "01HXYZ..."
    method: "POST"
    path: "/stores/01HABC.../check"
    status: 200
    durationMs: 4.2
```

CI and `pnpm start` (production) emit raw JSON. Pipe through
`pino-pretty` manually when tailing prod logs locally:

```sh
ssh prod-1 'tail -f /var/log/openfga/server.log' | pino-pretty
```

## Request log fields

Each completed request emits one structured line via
`src/middleware/request-log.ts`:

| Field | Meaning |
|---|---|
| `reqId` | ULID generated per request. Returned to the caller as `X-Request-ID`. |
| `method` | HTTP method. |
| `path` | Route path *with parameters templated* (e.g., `/stores/:storeId/check`). |
| `status` | Response status code. |
| `durationMs` | Wall-clock time from middleware entry to response start. |
| `userAgent` | Client `User-Agent` (truncated to 256 chars). |

`reqId` is the load-bearing field for correlation. When OpenTelemetry
is enabled, the request span carries the same id under the
`openfga.request_id` attribute, and the `X-Request-ID` response
header lets callers correlate their own logs against the server's.

## Auth rejection logs

Auth middleware logs every rejection with a structured `reason`. The
full set is in [Authentication](/guide/authentication#failure-reporting).
Auth rejection lines do NOT include the offending token value — the
secret material is never in the log stream.

## Storage logs

`src/storage/*` modules use a child logger with `component: 'storage'`.
Notable lines:

- `migration_applied` — emitted by the migrator with the migration
  name and direction (`up` / `down`).
- `pool_acquired_timeout` — surfaces a connection-pool exhaustion
  signal before the request itself returns 500.
- `engine_context_loaded` — the per-store cached model index has been
  rebuilt. Includes `storeId` and `modelId`.

## Shipping logs

The server writes only to stdout (and stderr for fatal panics). Use
your platform's log shipper:

- **Docker / Kubernetes** — the container runtime captures stdout.
  Ship via the cluster's log pipeline (fluent-bit, Vector, Loki).
- **systemd** — `journalctl -u openfga-node-server -f` reads from
  journald.
- **Direct file** — pipe stdout to a file with rotation:
  `pnpm start | rotatelogs /var/log/openfga/server.%Y%m%d.log 86400`.

Don't try to make the server write to a file directly. The
log-handling primitives in Node — particularly around uncaught
exceptions during file-handle reopen on rotation — are not friendly
to long-running production processes. Let an external rotator
handle it.

## What goes in trace level

Setting `log.level: trace` enables:

- `pg` driver query logs (every parameterized statement and its
  parameter array).
- `hono` route-match decisions.
- `jose` JWT validation step trace (when `auth.mode = oidc`).

Trace is for debugging a misbehaving deployment. Don't run it in
steady-state production — log volume spikes ~10x and includes query
parameter values.

## See also

- [Health & Readiness](/guide/health-readiness) — what the probes log
  on failure
- [Observability](/guide/observability) — OTel correlation via
  `reqId`
