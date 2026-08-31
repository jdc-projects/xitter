# 06 · Observability

Observability is part of development work, not an afterthought: dashboards and alerts for new behaviour ship in the same PR. The entire stack — collector, Tempo, Prometheus rules, Grafana dashboards and alerting — is provisioned via Tofu (CRs + providers), never hand-clicked.

## Traces

| Aspect          | Rule                                                                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Instrumentation | OTel auto-instrumentation: `http`/Fastify (inbound), `undici` (outbound HTTP), `kafkajs` (produce/consume), `pg` (queries) — services and workers                                                                                                            |
| Propagation     | W3C `traceparent` propagated service→service and over Kafka message headers; the edge starts or continues the root trace from the browser                                                                                                                    |
| Export          | OTLP → OTel collector → Tempo; collector handles batching, retry, and env routing                                                                                                                                                                            |
| Span naming     | HTTP: `{METHOD} {route template}` (e.g. `POST /api/posts/v1/posts`, never raw paths with ids). Kafka: `kafka produce {topic}`, `kafka consume {topic}`. DB: `prisma {model}.{op}`. Valkey: `publish feed:updates:{userId}` pattern as `publish feed:updates` |

## Metrics

- **RED metrics per API** via prom-client: request rate (`xitter_http_requests_total`), error rate and duration histogram (`xitter_http_request_duration_seconds`) — labelled by service, route template, and status class; exported on `/metrics` alongside the app port by the shared bootstrap.
- **Worker metrics**: consumer lag per group/topic (`xitter_kafka_consumer_lag{topic,partition}`), rebalance events (`xitter_kafka_rebalances_total{group}`), batch sizes, processing duration, eventId-dedupe hit rate.
- **Platform metrics**: feed freshness (`xitter_feed_newest_entry_age_seconds`, read from the feed store on every scrape), reset job run status (kube-state-metrics job series once #13 lands the CronJob).
- Scrape config via Prometheus `ServiceMonitor`s for the services and `PodMonitor`s for the Knative workers (their metrics ports have no k8s Service to select), declared in Tofu.

## Health probes

| Aspect | Rule                                                                                                                                                                                                                                                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Paths  | `GET /healthz` (liveness) and `GET /readyz` (readiness) at the root — outside the `api/{service}/v1` prefix, because they serve infrastructure probes, not the public API. web serves the same pair from root-level Next route handlers; cms serves them under its `/cms` basePath (`/cms/healthz`, `/cms/readyz`)                                     |
| Shape  | Nest Terminus via the shared `@xitter/health` module; workers answer `GET /healthz` on their metrics server (the listener being up means the process is alive)                                                                                                                                                                                         |
| Checks | Liveness checks nothing (a slow dependency must not get a healthy pod killed). Readiness pings the service's Prisma database (`SELECT 1`, 2s timeout) and answers 503 until it responds. web and cms readiness intentionally check nothing downstream: SSR fetches fail soft per the product resilience rules, and probe depth belongs to the services |
| Static | admin is static files behind Caddy; `/healthz` + `/readyz` answer 200 there (likewise under `/admin/`, via the SPA fallback for the shell)                                                                                                                                                                                                             |

## Logs

- pino JSON to stdout via the shared observability package; Kubernetes collects. Never log tokens, credentials, or post bodies.
- Correlation: `traceId`/`spanId` (and `eventId` in workers) are part of the log context on every line, so a Tempo trace links straight to logs and back.

## Sentry

| Aspect          | Rule                                                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project         | ONE project (`xitter`) for every workload — cross-service traces and issue correlation are the point of Sentry, and both need a single event stream |
| DSN             | One shared DSN, injected as a secret at deploy (see [07-security.md](07-security.md))                                                               |
| Release tagging | Sentry release = the deployed image tag (`sha-<short>` from CI, or the promoted release tag)                                                        |
| Environment     | `SENTRY_ENVIRONMENT` (`dev`/`prod`) separates the streams within the project                                                                        |
| Scope           | `service` tag on every event + trace id attached; release-health enabled for web                                                                    |

The project is provisioned by Tofu (`jianyuan/sentry` provider, under the `xitter` team) and owned by the **shared root** (`infra/iac/environments/shared`, state `xitter-shared`, [ADR 0013](../../decisions/0013-shared-sentry-root.md)) — a resource cannot live in two states, so neither environment owns it. The project carries `prevent_destroy` (every environment's DSN secret points at its key). `dev` and `prod` each materialise the same DSN — read from the shared root's `sentry_dsn_public` output — into their own `xitter-sentry` secret, so a release never depends on dev's apply timing and destroying an environment cannot orphan the other's DSN. The shared `SENTRY_DSN` secret and the `SENTRY_ENVIRONMENT`/`SENTRY_RELEASE` env are part of each environment root module. Per-workload filtering is the `service` tag every SDK init stamps (`initSentry` server-side, `instrumentation-client` for the browser). web additionally reports from the browser via `@sentry/nextjs`: the server relays the runtime DSN/release/environment to `instrumentation-client.ts` through a JSON script tag, because build-time inlining cannot see deploy-time secrets.

## Dashboards (required)

| Dashboard                  | Contents                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| API overview (per service) | R/E/D, p50/p95/p99 per route; upstream dependency time is trace-derived (Tempo link), not a Prometheus panel             |
| Feed freshness / lag       | Newest-entry age, fanout worker backlog → time-to-feed SLO                                                               |
| Kafka consumer lag         | Lag per consumer group × topic, rebalance events                                                                         |
| Reset job                  | Nightly reset success/failure, phase durations, reseed row counts                                                        |
| Web vitals                 | CWV (LCP/INP/CLS) per page, JS error rate — served by Sentry's Web Vitals views from the browser SDK, not Grafana panels |

Dashboards are `GrafanaDashboard` CRs in the environment root module (the grafana-operator files them into a folder named after the namespace). The reset-job dashboard renders empty until #13 ships the CronJob.

## Alerts (required)

| Alert                 | Condition (defaults; tune via Prometheus rules in Tofu)                               |
| --------------------- | ------------------------------------------------------------------------------------- |
| API 5xx rate          | >1% of requests over 5m on any service                                                |
| API p95 latency SLO   | >500ms over 10m (API endpoints)                                                       |
| Page p95 SLO          | >2s over 10m (web page loads, measured at the edge)                                   |
| Consumer lag          | Group lag above threshold for 10m (per-group tunable; fanout is the SLO-critical one) |
| Reset job failure     | Nightly CronJob not `Succeeded` by 02:00 UTC                                          |
| Cert / ingress errors | Edge 5xx on ingress routes, cert expiry <14d, TLS validation failures                 |

Rules live as one `PrometheusRule` per environment root module. Routing rides the homelab convention: alerts carry a `severity` label (`warning`/`critical`) and the homelab Alertmanager config routes them to its email receiver (`severity = none` goes to null), so no xitter-specific notification resources exist.

Alert routing (notification channels, on-call expectations) is defined in the [operations specs](../operations/).
