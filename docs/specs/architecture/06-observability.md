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

- **RED metrics per API** via prom-client: request rate, error rate, duration histogram — labelled by service, route template, and status class; exported on `/metrics`.
- **Worker metrics**: consumer lag per group/topic, batch sizes, processing duration, eventId-dedupe hit rate.
- **Platform metrics**: feed freshness (age of newest entry per user cohort), reset job run status.
- Scrape config via Prometheus `ServiceMonitor`s (and equivalent pod annotations for Knative worker revisions), declared in Tofu.

## Logs

- pino JSON to stdout via the shared observability package; Kubernetes collects. Never log tokens, credentials, or post bodies.
- Correlation: `traceId`/`spanId` (and `eventId` in workers) are part of the log context on every line, so a Tempo trace links straight to logs and back.

## Sentry

| Aspect          | Rule                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------- |
| DSNs            | Per app/service/worker, injected as a secret at deploy (see [07-security.md](07-security.md)) |
| Release tagging | Sentry release = image tag (semver, from CI)                                                  |
| Environment     | `XITTER_ENV` maps directly to the Sentry environment (`dev`, `prod`)                          |
| Scope           | Service name + trace id attached; release-health enabled for web                              |

## Dashboards (required)

| Dashboard                  | Contents                                                                    |
| -------------------------- | --------------------------------------------------------------------------- |
| API overview (per service) | R/E/D, p50/p95/p99 per route, upstream dependency time (pg, other services) |
| Feed freshness / lag       | Newest-entry age distribution, fanout worker backlog → time-to-feed SLO     |
| Kafka consumer lag         | Lag per consumer group × topic, rebalance events                            |
| Reset job                  | Nightly reset success/failure, phase durations, reseed row counts           |
| Web vitals                 | CWV (LCP/INP/CLS) per page, JS error rate                                   |

## Alerts (required)

| Alert                 | Condition (defaults; tune via Prometheus rules in Tofu)                               |
| --------------------- | ------------------------------------------------------------------------------------- |
| API 5xx rate          | >1% of requests over 5m on any service                                                |
| API p95 latency SLO   | >500ms over 10m (API endpoints)                                                       |
| Page p95 SLO          | >2s over 10m (web page loads)                                                         |
| Consumer lag          | Group lag above threshold for 10m (per-group tunable; fanout is the SLO-critical one) |
| Reset job failure     | Nightly CronJob not `Succeeded` by 01:00 UTC                                          |
| Cert / ingress errors | Edge 5xx on ingress routes, cert expiry <14d, TLS validation failures                 |

Alert routing (notification channels, on-call expectations) is defined in the [operations specs](../operations/).
