# ADR 0009: Local dependency isolation

## Status

Decided — 2026-08-15

## Context

Multiple parallel copies of the environment (worktrees, experiments, another developer's stack on the same machine) must not collide on ports, docker containers, volumes, or networks. The compose stack is shared infrastructure locally; app code runs on the host against it.

## Decision

- **`XITTER_ENV` env var** drives the compose project name: `xitter-${XITTER_ENV}`. Each project gets isolated containers, volumes, and networks.
- **`XITTER_PORT_OFFSET`** is applied to every published port via `@xitter/config`'s `localPort()`, so parallel stacks never fight over host ports.
- **All ports and URLs are env-driven in every app from day one** — no hardcoded ports or URLs anywhere (repo rule).
- **One `.env` per checkout**, with `.env.example` as the committed non-secret defaults.
- Traefik's dynamic config templates (Go-templated on `XITTER_*_PORT`) consume the same variables, so the edge routes follow whatever offset is in play.

## Options

| Option                                                | Pros                                                                                               | Cons                                                                                          | Verdict    |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------- |
| Fixed ports                                           | Predictable                                                                                        | Collisions the moment a second copy runs; breaks worktree workflows                           | Rejected   |
| Docker networking only (no host ports)                | No host port conflicts at all                                                                      | Host-run apps must reach dependencies somehow — without published ports they can't            | Rejected   |
| Dynamic random ports                                  | Zero configuration                                                                                 | Hard to reason about and debug; URLs become nondeterministic; poor DX                         | Rejected   |
| **Project name + deterministic port offset (chosen)** | Parallel copies are fully isolated yet predictable; one env var pair per checkout; no config drift | Offsets must be chosen/remembered per copy (mitigated by `.env` per checkout and `env:print`) | **Chosen** |

## Consequences

- Any code or config that hardcodes a port or URL is a bug; `@xitter/config` is the only path to port/URL resolution.
- `npm run env:print` shows the resolved ports for a checkout, which is the debugging escape hatch.
- Copying `.env.example` to `.env` and tweaking `XITTER_ENV`/`XITTER_PORT_OFFSET` is all that's needed to run a second stack.
- CI and deployed environments don't use offsets (fixed cluster ports/domains), but benefit from the same env-driven discipline.
