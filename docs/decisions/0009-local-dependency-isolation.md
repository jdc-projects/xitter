# ADR 0009: Local dependency isolation

## Status

Decided — 2026-08-15

## Context

Multiple parallel copies of the environment (worktrees, experiments, another developer's stack on the same machine) must not collide on ports, docker containers, volumes, or networks. The compose stack is shared infrastructure locally; app code runs on the host against it.

The original formulation left the interaction between `XITTER_PORT_OFFSET` and an explicit `XITTER_<NAME>_PORT` undefined. The first `.env.example` shipped every port variable uncommented, so a copied `.env` set explicit values for all ports — and with precedence undefined, the offset silently shifted nothing below the app layer. Parallel copies appeared isolated while colliding on the host's actual ports.

## Decision

- **`XITTER_ENV` env var** drives the compose project name: `xitter-${XITTER_ENV}`. Each project gets isolated containers, volumes, and networks.
- **Port precedence (fixed)**: an explicit `XITTER_<NAME>_PORT` variable is an **absolute pin** — used verbatim, the offset is ignored. Otherwise the default plus `XITTER_PORT_OFFSET`. `.env.example` therefore ships all port variables commented out; uncommenting one pins it deliberately.
- **All ports and URLs are env-driven in every app from day one** — no hardcoded ports or URLs anywhere (repo rule).
- **One `.env` per checkout**, with `.env.example` as the committed non-secret defaults.
- Traefik's dynamic config templates (Go-templated on `XITTER_*_PORT`) consume resolved ports via a generated compose env file, so docker publishes and edge routes follow whatever offset is in play.

## Options

Isolation mechanism:

| Option                                                | Pros                                                                                               | Cons                                                                                          | Verdict    |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------- |
| Fixed ports                                           | Predictable                                                                                        | Collisions the moment a second copy runs; breaks worktree workflows                           | Rejected   |
| Docker networking only (no host ports)                | No host port conflicts at all                                                                      | Host-run apps must reach dependencies somehow — without published ports they can't            | Rejected   |
| Dynamic random ports                                  | Zero configuration                                                                                 | Hard to reason about and debug; URLs become nondeterministic; poor DX                         | Rejected   |
| **Project name + deterministic port offset (chosen)** | Parallel copies are fully isolated yet predictable; one env var pair per checkout; no config drift | Offsets must be chosen/remembered per copy (mitigated by `.env` per checkout and `env:print`) | **Chosen** |

Port override precedence:

| Option                               | Pros                                                      | Cons                                                                    | Verdict    |
| ------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------- | ---------- |
| Env var + offset combined            | No "silent pin" surprises                                 | A pinned port can silently collide with another service's shifted range | Rejected   |
| **Env var as absolute pin (chosen)** | Predictable, self-documenting, matches "uncomment to pin" | Users who pin must pick ports outside every offset range they use       | **Chosen** |
| Error if both set                    | Safest                                                    | Breaks `.env` copies and CI presets; noisy for a demo repo              | Rejected   |

## Consequences

- Any code or config that hardcodes a port or URL is a bug; `@xitter/config` is the only path to port/URL resolution.
- Offset-only parallel copies work with no configuration; explicit pins are opt-in and visible in the user's `.env`.
- `npm run env:print` shows the resolved ports for a checkout, which is the debugging escape hatch.
- Copying `.env.example` to `.env` and tweaking `XITTER_ENV`/`XITTER_PORT_OFFSET` is all that's needed to run a second stack.
- CI and deployed environments don't use offsets (fixed cluster ports/domains), but benefit from the same env-driven discipline.
