# 07 · Security

End-state security posture. This is a demo platform with no real users or PII, but it practices production-shaped controls: single entry point, least privilege, no shared credentials, no secrets in the repo.

## Authentication

| Principal            | Mechanism                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web users            | Keycloak 26, `xitter-demo` realm, PKCE public client; demo users `demo1`–`demo10` (password `DemoPass123!`); realm recreated nightly                  |
| Login bot protection | Cap.js captcha on login; site verification performed server-side in web app routes                                                                    |
| CMS / admin          | Homelab **primary** realm; gated on `app-admin` (cms) and `system-admin` (admin) roles                                                                |
| Service-to-service   | Keycloak client credentials; clients `svc-social`, `svc-posts`, `svc-media`, `svc-feed`, `svc-search`; token audience = receiving service's client id |

**Edge vs service validation — decided:** in the cluster, the homelab Traefik ingress (`auth_mode=oidc-api`) validates Keycloak access tokens and injects identity headers (`X-User-Id`, …); services **trust the injected headers for requests originating within the namespace** and do not re-validate every request. An optional token re-check is reserved for a small allowlist of sensitive operations (initially empty). Locally there is no edge auth layer, so services validate Bearer tokens directly against Keycloak. Both modes produce the same request context; the mode is environment-driven, not per-service.

## Authorisation

| Rule                               | Enforcement                                                                                                                                                                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No content visible unauthenticated | Web gates all pages; services reject unauthenticated requests                                                                                                                                                                                                    |
| Own-resource mutation only         | Profiles, posts, interactions: mutation limited to the owning user id                                                                                                                                                                                            |
| Blocks                             | A blocked user cannot like/repost/reply to the blocker's posts and cannot follow the blocker — rejected at write time (`403 FORBIDDEN`). Historical feed entries remain until reset (product decision, see [04-event-driven-flows.md](04-event-driven-flows.md)) |
| Internal endpoints                 | Service tokens only (audience = receiving service); never user tokens                                                                                                                                                                                            |
| Admin surfaces                     | cms/admin APIs role-gated (`app-admin` / `system-admin`) from the primary realm                                                                                                                                                                                  |

## Network segmentation

Default deny; every allow is explicit (NetworkPolicies deployed with each env via Tofu):

| Policy         | Rule                                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public ingress | Only the edge (ingress namespace) may reach service public ports                                                                                    |
| Internal APIs  | Only pods within the environment namespace may reach `/internal` paths — L7 enforced by service-token authz on top of namespace-scoped L3/L4 allows |
| Workers        | No inbound except metrics scrape; they reach Kafka, service internal APIs, and RustFS by egress                                                     |
| Datastores     | Postgres/OpenSearch/Valkey/RustFS reachable only from their owning services/workers (and the reset job), never from the edge                        |
| Egress         | Per-workload egress limited to required destinations (identity, brokers, stores, OTLP)                                                              |

## Kubernetes RBAC

- One ServiceAccount per app/service/worker; no shared identities.
- No cluster-wide roles; workload SAs get no Kubernetes API permissions beyond none-by-default.
- Knative worker revisions run under their worker's SA; reset CronJob has a dedicated SA scoped to its job.

## Secrets management

- All secrets (Keycloak client secrets, DB roles/passwords, Sentry DSNs, object-storage keys) are managed by Tofu and materialised into Kubernetes `Secret`s at deploy time; Tofu state backend is access-controlled.
- No secrets in the repo, ever. Local `.env` files contain non-secret defaults only (ports, URLs, flags).
- Presigned upload URLs are short-lived and scoped to a single object key.

## Data protection

- **No PII by design**: profiles and posts contain fictional demo content only; seed data is faker-generated. Docs and UI state this clearly — treat any entered text as public and disposable.
- Nightly reset wipes all stores ([05-data-platform.md](05-data-platform.md)); Velero backup explicitly excludes the `xitter-*` namespaces, so nothing user-generated leaves the cluster.
- Logs never contain tokens or post bodies; Sentry scrubbing is enabled.

## Rate limiting

Valkey-backed token bucket, keyed per `userId` + IP, applied to **mutation endpoints** (post/reply creation, interactions, follows/blocks, upload slot creation). Exceeding the bucket returns `429 RATE_LIMITED` with a `Retry-After` header. Defaults are conservative and tunable per route class; buckets reset nightly with everything else.

## Image and dependency hygiene

- Images built per app/service on merge (GitHub Actions) from pinned bases; semver tags per environment promotion (see [01-system-overview.md](01-system-overview.md)).
- CI vulnerability scanning of images and dependencies; failures gate the PR.
- Dependency versions pinned to major (`^16`) or minor for sub-1.0; lockfiles committed and updated deliberately.
