# TLS / HTTPS

NodeFGA can terminate TLS directly via Node's built-in
`tls` module, or run plain HTTP behind an upstream terminator (load
balancer, ingress, service mesh).

## Configuration

```yaml
tls:
  certFile: /etc/openfga/tls/cert.pem
  keyFile:  /etc/openfga/tls/key.pem

listeners:
  http:
    enabled: true       # HTTP listener stays up alongside HTTPS
    port: 8080
  https:
    port: 8443
```

Or env vars:

```sh
OPENFGA_TLS_CERT_FILE=/etc/openfga/tls/cert.pem
OPENFGA_TLS_KEY_FILE=/etc/openfga/tls/key.pem
OPENFGA_HTTPS_PORT=8443
```

## Boot behavior

| `tls.certFile` | `tls.keyFile` | Result |
|---|---|---|
| set | set | HTTPS listener starts on `listeners.https.port`. HTTP listener stays up if `listeners.http.enabled: true`. |
| unset | unset | HTTP only. |
| one set, one unset | — | FATAL — schema rejects this at validation. |

The schema enforces both-or-neither at config-load. Boot fails fast
with a structured Zod error rather than starting half-configured.

## Cert formats

- **PEM only.** Both files must be PEM (`-----BEGIN …-----`). DER is
  not supported.
- **Cert file** may include the leaf + intermediates concatenated
  (the typical "fullchain" format).
- **Key file** is the unencrypted private key. Encrypted keys are
  not supported — use a deploy-time secret manager to decrypt before
  writing the file.

The files are read once at boot. The server does NOT watch the
filesystem for cert rotation. To rotate certs, restart the process
(or signal a reload via your orchestrator's rolling restart).

## Local development

Generate locally-trusted certs via mkcert with one command:

```sh
pnpm cert:create
```

The script:

1. Runs `mkcert -install` to register a local root CA in your OS
   trust store and browser.
2. Issues a cert for `localhost`, `127.0.0.1`, `::1`.
3. Writes them to `.certs/localhost.pem` and `.certs/localhost-key.pem`.
4. Prints the env-var snippet to paste into your shell or `.env`:

```sh
OPENFGA_TLS_CERT_FILE=$PWD/.certs/localhost.pem
OPENFGA_TLS_KEY_FILE=$PWD/.certs/localhost-key.pem
NODE_EXTRA_CA_CERTS=$PWD/.certs/rootCA.pem  # optional, for SDK callers
```

After `pnpm dev`, the server listens on both `http://localhost:8080`
and `https://localhost:8443` with a cert your browser trusts.

## Behind a terminator (recommended for production)

For most production deployments, **don't terminate TLS at the
application**. Use:

- **Kubernetes** — an ingress controller (nginx-ingress, Traefik,
  Caddy) or service mesh (Istio, Linkerd).
- **AWS** — an ALB or NLB with ACM-managed certs.
- **GCP** — a managed HTTPS load balancer.
- **bare-metal / VM** — Caddy, HAProxy, or nginx.

Run the server with `tls.certFile` and `tls.keyFile` unset; expose
`:8080` only on the internal network. The terminator handles cert
rotation, ALPN/HTTP2 negotiation, OCSP stapling, and SNI for
multi-tenant hostnames.

Why? Cert rotation, mTLS, modern cipher policy, ACME automation —
the upstream tooling does these well. Reimplementing them inside the
application means tracking CVEs in your TLS stack as part of every
release.

## When in-process TLS is the right call

- **Embedded deployments.** Single-binary distributions where adding
  a sidecar terminator is overhead.
- **Compliance regimes that require end-to-end TLS.** Some auditors
  want the cert chain visible *at the application*, not just at the
  edge.
- **Local development.** `pnpm cert:create` is the easiest path to
  `https://localhost` without standing up an extra container.

For these cases the built-in TLS path is fine. For everything else,
keep TLS out of the app.

## HTTP/2

The HTTPS listener uses Node's `https` module, which does HTTP/1.1
only. There is no HTTP/2 support in this server today. SDK clients
that need HTTP/2 multiplexing should connect through a load
balancer that handles the protocol upgrade.

## See also

- [Installation](/guide/installation) — `pnpm cert:create` invocation
- [Deployment Runbook](/runbooks/deployment) — production wiring
