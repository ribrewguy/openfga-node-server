# Enable OpenTelemetry

This runbook walks the path from "OTel off" to "spans flowing into
a collector" in production.

## Prerequisites

- An OTLP-compatible collector reachable from the server
  (OpenTelemetry Collector, Tempo, Honeycomb, Datadog, Lightstep,
  New Relic, etc.).
- The collector's OTLP endpoint URL. Note whether it speaks `http`
  (port 4318) or `grpc` (port 4317).

## Step 1 — Stand up a collector (if you don't have one)

For local testing, spin up the OpenTelemetry Collector in Docker:

```sh
docker run -d --name otel-collector \
  -p 4317:4317 -p 4318:4318 \
  otel/opentelemetry-collector:latest
```

The default config logs received spans to stdout. View with
`docker logs -f otel-collector`.

For production, deploy a managed collector with exporters configured
to your backend (Tempo, Honeycomb, Datadog, etc.). Don't make the
server talk directly to a SaaS backend; route through a collector so
you can centralize sampling and redaction policy.

## Step 2 — Configure the server

Minimum production config:

```yaml
otel:
  enabled: true
  service:
    name: openfga-node-server
    version: ''                   # auto-fills from package.json
  exporter:
    type: otlp-http
    endpoint: http://otel-collector.observability:4318/v1/traces
  sampler:
    type: parentbased_traceidratio
    ratio: 0.05                   # 5% of root-sampled traces
  resource:
    attributes:
      deployment.environment: production
      service.namespace: auth-platform
```

Or via env vars:

```sh
OPENFGA_OTEL_ENABLED=true
OPENFGA_OTEL_EXPORTER_TYPE=otlp-http
OPENFGA_OTEL_EXPORTER_ENDPOINT=http://otel-collector.observability:4318/v1/traces
OPENFGA_OTEL_SAMPLER_TYPE=parentbased_traceidratio
OPENFGA_OTEL_SAMPLER_RATIO=0.05
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production,service.namespace=auth-platform
```

## Step 3 — Restart and verify

Restart the server. On boot:

- `otel_setup_ok` log line with the resolved exporter type.
- `FATAL otel_setup_failed` → bad exporter URL or unsupported config.
  Server refuses to start.

Hit any endpoint. Within a few seconds, check the collector for
incoming spans. With the default OTel Collector logging exporter,
`docker logs -f otel-collector` shows JSON span dumps.

Spans you should see on a single `/check` call:

```
openfga.http POST /stores/:storeId/check   (root)
└─ openfga.evaluator.check
    └─ openfga.storage.read_tuples   (×N)
```

If you don't see spans, see "Common errors" below.

## Step 4 — Tune span categories

Default has every category on. In production, the firehose volume
may be unwanted:

```yaml
otel:
  enabled: true
  spans:
    http: true          # always-on root context
    evaluator: true     # always-on; signal-rich
    storage: false      # firehose at scale — disable in prod
    auth: true
    idempotency: true
```

Storage spans average 5–10× the evaluator span count for non-trivial
models. Most teams disable storage spans in production after the
initial debugging window.

## Step 5 — Sampling at scale

`parentbased_traceidratio` is the recommended sampler:

- **If an upstream trace was sampled**, this one is too — causality
  across services is preserved.
- **If we're the root**, sample `ratio` of traces. 0.05 (5%) is a
  reasonable starting point for high-volume deployments.

Adjust based on:

- **Throughput.** At 10k req/s, even 1% is 100 traces/s — plenty for
  diagnosis.
- **Storage cost** at your backend. Most SaaS observability tools
  charge per span ingested.
- **Slow-trace coverage.** If you sample at 0.001 (0.1%) and a slow
  request happens once per million, you'll see <1 per day on average.

## Step 6 — OTLP headers (auth, etc.)

Some collectors require authentication. For OTLP HTTP, set headers:

```yaml
otel:
  exporter:
    type: otlp-http
    endpoint: https://api.honeycomb.io/v1/traces
    headers:
      x-honeycomb-team: hcaik_xxxxx
```

For OTLP gRPC, headers come through metadata via the standard
`OTEL_EXPORTER_OTLP_HEADERS` env var:

```sh
OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=hcaik_xxxxx
```

The static `headers:` config field works for OTLP HTTP only. The
schema rejects sensitive headers (`authorization`, `cookie`,
`x-api-key`, etc.) — set those via the env var path if your
collector demands them, since the env path is operator-owned.

## Step 7 — Trace context propagation

By default the server uses W3C Trace Context and Baggage. To add
B3 propagation (Zipkin compatibility):

```yaml
otel:
  propagators:
    - tracecontext
    - baggage
    - b3
```

Or `b3multi` for multi-header B3. Order matters for *injection* (the
first propagator wins on outgoing requests); for *extraction* the
server tries each.

## Common errors

| Symptom | Likely cause |
|---|---|
| `FATAL otel_setup_failed` at boot | Bad exporter URL, unsupported sampler type, unsupported propagator. Read the error detail. |
| Server starts but no spans arrive | Endpoint typo (especially `/v1/traces` vs `/v1/trace`). For OTLP HTTP, the full path is `<host>:4318/v1/traces`. |
| Spans arrive but the trace tree is broken | A propagator mismatch — upstream sends B3, we extract only Trace Context. Add `b3` to `otel.propagators`. |
| Storage span volume crushes the backend | Disable `otel.spans.storage`. |

## Disabling

To turn OTel off, set `otel.enabled: false` and restart. The OTel
SDK and all its transitive deps are NOT imported when disabled —
the runtime graph reverts to what it was before this feature
shipped.

## See also

- [Observability](/guide/observability) — full span catalog and
  contract
- [Deployment](/runbooks/deployment) — full production runbook
