# ADR 0011: CI tofu runs route providers in-cluster (PR plans included)

## Status

Decided — 2026-08-26

## Context

The `keycloak/keycloak` and `jianyuan/sentry` providers authenticate as part of provider init: an admin-cli password grant against the Keycloak token endpoint and a Sentry API health check. Their endpoints come from homelab remote state — the public, Cloudflare-fronted URLs (`idp.jd-chapman.dev`, the Sentry domain).

Every tofu CI job (pr-gates `tofu`/`tofu-plan`, deploy-dev `tofu-apply`, release `tofu-apply`) runs on the single self-hosted LAN runner, because the cluster API is private. From that runner, public-URL requests egress via the **home IP**. CrowdSec bans on that IP (dynamic IP, tripped by unrelated traffic and credential-grant bursts) 403 the provider login and kill the run.

- #72 fixed deploy-dev: `provider_keycloak_url` / `provider_sentry_base_url` override variables, with the deploy passing in-cluster service URLs so no edge sits in the path.
- #78/#83 mirrored the overrides to prod applies.
- The pr-gates `tofu-plan` job was left on the public URLs — issue #100. Live hit: PR #99's gate run (2026-08-25) failed with `error initializing keycloak provider … POST …/realms/master/protocol/openid-connect/token: 403` and `failed to perform health check … unexpected status code: 403` (Sentry), costing a rerun cycle — and while a ban is live, every tofu auth sharing the home IP is blocked, applies included.

Issue #100 framed the problem as "PR tofu jobs run on GitHub-hosted runners, so they cannot use the in-cluster URLs". That premise was wrong — both jobs have been `runs-on: self-hosted` since their introduction (#15). What was actually missing was the second half of the issue's own recommendation: pass the same overrides deploy-dev uses.

Two adjacent non-problems, to keep the option space honest:

- **Provider binary downloads** (`tofu init` fetching from `registry.opentofu.org`) are not part of this failure class. The registry is a public CDN with no CrowdSec in the path, installs take ~2 s in the CI logs, and the validate job (which does the downloading) has never failed on them.
- **There is no provider mirror to point at** — #72/#83 are API-endpoint routing, not a registry mirror; the dispatcher-era "in-cluster mirror" framing does not correspond to anything in this repo.

## Decision

The pr-gates `tofu-plan` job passes the same in-cluster provider URLs as deploy-dev (#72) and release (#83) applies:

- `TF_VAR_provider_keycloak_url=http://keycloak-keycloakx-http.keycloak:80`
- `TF_VAR_provider_sentry_base_url=http://sentry-web.sentry:9000/api/`

All tofu plan/apply jobs on the LAN runner now route both providers in-cluster: no tofu authentication from CI crosses the edge, so a CI plan can neither trip a CrowdSec ban nor be killed by a live one.

A failure-annotation step names the endpoints in play, so a provider-init failure is diagnosable from the job annotations without scrolling the plan output: a 403 against an `https://*.jd-chapman.dev` URL means the override did not apply; a failure against the `http://` in-cluster URLs means the service itself.

The pr-gates `tofu` validate job is untouched: `init -backend=false` + `validate` never configure providers (no Keycloak/Sentry API calls), and its registry downloads are not CrowdSec-exposed. Local/manual runs keep the public URLs by default (the override variables default to empty); the deploy runbook documents that failure mode for local runs.

## Options

| Option                                              | Pros                                                                                     | Cons                                                                                                                                                                                                  | Verdict    |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **In-cluster overrides on the PR plan (chosen)**    | Uniform with deploy/release; zero edge crossings; 2-line change; no homelab-side changes | PR gating shares the LAN runner with applies (queueing, single point) — but it already did, since #15                                                                                                 | **Chosen** |
| Homelab CrowdSec exception for the token endpoint   | Keeps public URLs everywhere                                                             | Change outside this repo; widens the brute-force-adjacent surface spec 07 leans on; the fleet's direction of travel is fewer edge crossings (the runtime moved in-cluster, #94), not more exceptions  | Rejected   |
| Accept + heal (delete the ban when tripped)         | No change                                                                                | Every occurrence costs a rerun cycle and blocks applies sharing the home IP (live: #99's gate run)                                                                                                    | Rejected   |
| Vendor provider binaries / repo provider mirror     | Hermetic `tofu init`                                                                     | Solves registry downloads, which have never failed; ~5 providers × 2 envs of binaries living in the repo; signature/lockfile hygiene to maintain; does not touch the API-endpoint failure mode at all | Rejected   |
| `actions/cache` of providers keyed on lockfile hash | Faster init                                                                              | Same non-problem (installs ~2 s, no failures); does nothing for provider auth                                                                                                                         | Rejected   |

## Consequences

- PR plans no longer depend on CrowdSec's mood: provider auth cannot trip or eat a home-IP ban, and a pre-existing ban can no longer fail a PR plan.
- `tofu-plan` now depends on the in-cluster Keycloak and Sentry services being reachable from the runner — the same dependency deploys have carried since #72 (proven in every apply since).
- A plan failing at provider init now surfaces connection errors against the in-cluster `http://` URLs instead of 403s against public ones; the annotation step distinguishes the two readings.
- Issue #100's option 1 is satisfied in full: the runner-class half was already true; this record completes the routing half.
