# ADR 0012: One Keycloak realm per environment

## Status

Decided — 2026-08-28

## Context

Dev and prod both deploy against the homelab's single Keycloak (`keycloak-config` remote state). When prod's environment was built (T13) it mirrored dev's `keycloak.tf` verbatim, including the realm name: both declared `keycloak_realm.demo` (`xitter-demo`), the `web` client, and the same `svc-*` machine clients.

Keycloak object ids are global per instance, not per Tofu state. Two states declaring the same objects do not merge — they fight:

- **First prod apply 409s**: dev's state already owns the realm/clients, so prod plans _creates_ the Keycloak API rejects as conflicts (the standard remedy, a one-time `tofu import` set, was documented nowhere).
- **Redirect URIs/origins flip-flop**: `web.valid_redirect_uris` is env-exclusive by nature (`https://<env domain>/*`). Post-import, each env's apply overwrites the other's login origin.
- **Client-secret rotation outages**: each state carries its own `random_password.machine_client_secret` values. Every apply rewrites the realm's machine-client secrets, invalidating the _other_ env's K8s Secrets — that env's M2M grants then 401 until its next apply.
- **Nightly reset crossfire** (the structural one): dev's reset/upsert path (`keycloak.ts`) rewrites the realm's `web` client with dev's edge origin and dev's brute-force posture. A shared realm means dev's nightly run repoints prod's login every night.

Fixing the secret half of a shared realm would require sharing one secret source across states (e.g. prod reading dev's remote state) — a second dev→prod state coupling of exactly the kind the runbook already flags as a trap for Sentry ("destroying dev takes prod's Sentry down").

## Decision

**Realm-per-environment**: each environment's `keycloak.tf` creates its own realm on the shared Keycloak.

- dev: `xitter-demo` (unchanged).
- prod: `xitter-demo-prod`.

Client ids stay **unprefixed** (`web`, `svc-*`): Keycloak namespaces clients by realm, so `web` in `xitter-demo-prod` and `web` in `xitter-demo` are distinct objects. Only the realm name differs, and every consumer already takes it from an env var driven by `local.demo_realm`:

- services/workers: `DEMO_REALM` + `KEYCLOAK_ISSUER` (workloads.tf)
- web: `XITTER_DEMO_REALM` (its default is dev's realm name — prod passes it explicitly; dev needs no override since its realm _is_ the default)
- edge: `keycloak_auth_realm` on the oidc-api routes; the geo-open idp path route is `^/realms/<demo_realm>(/.*)?$` (anchored regex — deliberately disjoint from sibling realms, so dev's and prod's geo-open routes never collide even at different priorities)

`packages/scripts/src/keycloak-parity.test.ts` pins both names, so reintroducing a collision fails CI.

Brute-force tuning (`quick_login_check_milli_seconds`) is aligned to one value (0) across dev tofu, prod tofu, and the shared `keycloak.ts` realm init that the ensure-demo-users job runs — with a shared code path touching the realm, divergence means permanent plan churn, not isolation.

## Options considered

| Option                                                    | Pros                                                                                           | Cons                                                                                                                                                                                                     | Verdict    |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **Realm-per-environment (chosen)**                        | Disjoint state ownership; no imports; intentional divergence safe; dev's reset confined to dev | A second realm to reason about; every realm-name consumer must be env-driven (they were); CrowdSec's homelab token-endpoint exception may be realm-path-scoped (verify at first deploy)                  | **Chosen** |
| Shared realm + `tofu import` into prod                    | One realm, one login surface                                                                   | Permanent cross-state fights: env-exclusive redirect URIs, per-state `random_password` rotations breaking the other env's M2M, `quick_login_check` churn; dev's nightly reset rewrites prod's web client | Rejected   |
| Shared realm + union redirect URIs + shared secret source | No 409s; secrets stable                                                                        | Every divergent attribute still fights; needs a dev→prod remote-state coupling for secrets (the Sentry-single-project trap, again); dev's reset still crossfire unless rewritten multi-env               | Rejected   |

## Consequences

- Prod's first apply plans clean _creates_ of its own realm/clients — no import step, and the first-release runbook needs no realm migration section.
- Dev is untouched: same realm, same reset, same state.
- The geo-open surface on `idp.jd-chapman.dev` widens by exactly one realm path (`/realms/xitter-demo-prod/*`); `realms/primary`, `/admin`, and every other realm stay UK-only. The homelab CrowdSec token-endpoint exception (if realm-scoped to `/realms/xitter-demo`) needs the prod realm added — flagged as a first-deploy verification gate, since runtime token traffic is in-cluster after #159's transport mirror and only browser-driven flows cross the edge.
- Until #13 lands, the ensure-demo-users upsert (`initDemoRealm`) creates script-owned `svc-reset`/`svc-admin` clients inside prod's realm with the local-convention fallback secrets — the same posture dev's realm already has for `svc-admin`. #13 replaces `svc-reset` with a Tofu-managed random secret, exactly as dev's is today.
- A future environment (e.g. staging) follows the pattern: its own `xitter-demo-<env>` realm, no coordination required.
