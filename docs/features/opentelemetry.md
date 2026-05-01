# OpenTelemetry

## Status

Proposed.

## Source of Truth

- PRD: `docs/PRD.md`, "OpenTelemetry observability".
- Middleware: `@hono/otel` HTTP instrumentation middleware.
- Propagation standards: W3C Trace Context and W3C Baggage through OpenTelemetry propagation.

## Business Intent

Deployments need request traces that connect the authorization server to upstream application traffic. When a client request arrives with existing OpenTelemetry trace context, this server should continue that trace rather than starting an unrelated trace. Operators also need configurable span metadata, exporter settings, and header capture behavior without code changes.

The implementation should use Hono's OpenTelemetry middleware rather than custom request tracing. It should configure header capture intentionally because the middleware does not capture request or response headers by default.

## Goals

- Add OpenTelemetry tracing for the Hono request-response lifecycle.
- Respect incoming propagation context from standard headers.
- Capture the standard propagation request headers by default as span attributes:
  - `traceparent`
  - `tracestate`
  - `baggage`
- Let operators override captured request and response headers through environment variables.
- Let operators configure service metadata, exporter endpoint, sampling, and related OpenTelemetry settings without code changes.
- Avoid capturing secrets or high-risk headers by default.

## Non-Goals

- Do not add fine-grained spans inside evaluator or storage internals in the initial feature.
- Do not capture all request headers by default.
- Do not capture `authorization`, cookies, shared keys, or idempotency keys by default.
- Do not require an OpenTelemetry collector for local development.
- Do not change OpenFGA API request or response shapes.

## Middleware Behavior

Use `@hono/otel` HTTP instrumentation middleware for Hono route tracing.

The middleware should be registered early enough to cover authentication, idempotency, route handling, and error responses. It should not prevent existing request logging from running.

Incoming propagation context must be extracted from request headers before the server span starts. At minimum, the implementation must support:

- W3C Trace Context: `traceparent`, `tracestate`.
- W3C Baggage: `baggage`.

Header propagation and header capture are separate concerns:

- Propagation links this server's span to an upstream trace.
- Capture records selected request or response headers as span attributes.

The implementation must not rely on header capture for trace propagation.

## Default Header Capture

Default captured request headers:

- `traceparent`
- `tracestate`
- `baggage`

Default captured response headers:

- None.

The implementation may add response headers later if a concrete operational use case exists. It must not capture sensitive response headers by default.

## Configuration

Use project-specific environment variables for application behavior and standard OpenTelemetry environment variables where they fit directly.

Project-specific variables:

- `OPENFGA_OTEL_ENABLED`: Enables or disables OpenTelemetry middleware. Default: `false`.
- `OPENFGA_OTEL_SERVICE_NAME`: Service name. Default: `openfga-node-server`.
- `OPENFGA_OTEL_SERVICE_VERSION`: Service version. Default: package version when available.
- `OPENFGA_OTEL_CAPTURE_REQUEST_HEADERS`: Comma-separated request headers to capture. Default: `traceparent,tracestate,baggage`.
- `OPENFGA_OTEL_CAPTURE_RESPONSE_HEADERS`: Comma-separated response headers to capture. Default: empty.
- `OPENFGA_OTEL_SPAN_NAME_MODE`: Span naming strategy. Default: middleware route naming.

OpenTelemetry-aligned variables:

- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
- `OTEL_EXPORTER_OTLP_HEADERS`
- `OTEL_SERVICE_NAME`
- `OTEL_RESOURCE_ATTRIBUTES`
- `OTEL_PROPAGATORS`
- `OTEL_TRACES_SAMPLER`
- `OTEL_TRACES_SAMPLER_ARG`

If both project-specific and standard service-name variables are set, the project-specific variable wins for this server's Hono middleware configuration. Standard OpenTelemetry SDK configuration can still use `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES`.

## Propagators

The default propagators should include:

- `tracecontext`
- `baggage`

If `OTEL_PROPAGATORS` is set, the implementation should honor it where the OpenTelemetry JavaScript SDK supports that configuration. Unsupported propagator names should fail startup with a clear configuration error rather than silently degrading trace continuity.

## Exporter and SDK Startup

When `OPENFGA_OTEL_ENABLED=false`, the server should not initialize the OpenTelemetry SDK or install the Hono OpenTelemetry middleware.

When `OPENFGA_OTEL_ENABLED=true`, the server should initialize tracing before building or serving the Hono app. Startup should validate required exporter configuration when traces are expected to leave the process.

Local development may support a console or no-op exporter if explicitly configured. Production should use OTLP-compatible configuration.

## Security and Privacy

Captured headers become telemetry data and may leave the deployment boundary. The default header capture list must remain narrow.

Do not capture by default:

- `authorization`
- `cookie`
- `set-cookie`
- `proxy-authorization`
- `x-api-key`
- `idempotency-key`

If operators override capture lists to include sensitive headers, that is an explicit deployment choice. Documentation must warn about the risk.

## Observability Signals

The initial feature focuses on tracing. Metrics may be emitted by the middleware when available, but metric dashboards and alerting are out of scope for the initial implementation.

Spans should include route, method, URL, status code, service name, and service version when supported by the middleware. The implementation should keep request logging as the low-cardinality operational log and tracing as distributed request context.

## Middleware Ordering

Recommended order:

1. OpenTelemetry middleware.
2. Request logging.
3. Authentication.
4. Idempotency.
5. OpenFGA route handlers.

This order lets the root request span include authentication and idempotency decisions while still preserving existing request logs.

## Acceptance Criteria

- The PRD includes OpenTelemetry observability in current scope.
- `docs/features/opentelemetry.md` defines propagation, header capture, configuration, security, and acceptance behavior.
- `OPENFGA_OTEL_ENABLED=false` preserves current runtime behavior.
- `OPENFGA_OTEL_ENABLED=true` installs Hono OpenTelemetry HTTP instrumentation.
- Incoming `traceparent` and `tracestate` link server spans to upstream traces.
- Incoming `baggage` is propagated according to OpenTelemetry SDK behavior.
- Default captured request headers include `traceparent`, `tracestate`, and `baggage`.
- Captured request and response headers are configurable by environment variable.
- Sensitive headers are not captured by default.
- Tests verify middleware installation behavior, default header capture configuration, and environment override parsing.
- Documentation describes the required environment variables and warns about sensitive header capture.

## Open Questions

- Should the first implementation include a console exporter for local development, or should it rely only on OTLP configuration?
- Should `/health` be traced by default, or should it be excluded to reduce noise?
- Should route-level spans be enough initially, or should later work add evaluator/storage spans for slow authorization decisions?
