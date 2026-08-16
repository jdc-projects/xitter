# ADR 0010: Port override precedence — pin beats offset

## Status

Decided — 2026-08-16

Supersedes the port-precedence wording in [0009-local-dependency-isolation.md](0009-local-dependency-isolation.md) (0009 remains accurate on everything else).

## Context

ADR 0009 established `XITTER_ENV` (compose project isolation) and `XITTER_PORT_OFFSET` (every local port shifts by a constant) for parallel environment copies. It stated the offset is applied to "every published port via `localPort()`", without defining what happens when a user also sets an explicit `XITTER_<NAME>_PORT` variable.

The original `.env.example` shipped every port variable uncommented, so a copied `.env` set explicit values for all ports — and with env-var precedence undefined, `XITTER_PORT_OFFSET` silently shifted nothing below the app layer. Parallel copies appeared isolated (separate compose projects) while colliding on the host's actual ports.

## Decision

`localPort(name)` precedence is now fixed and documented in `packages/config/src/ports.ts`:

1. An explicit `XITTER_<NAME>_PORT` environment variable is an **absolute pin** — used verbatim, the offset is ignored.
2. Otherwise the default port **plus** `XITTER_PORT_OFFSET`.

`.env.example` ships all port variables commented out; uncommenting one pins it deliberately. Offset-based parallelism works out of the box, and pins are always visible in the user's `.env`.

## Options

| Option                                      | Pros                                                                                                 | Cons                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Env var + offset combined (pin shifted too) | No "silent pin" surprises                                                                            | A pinned port can silently collide with another service's shifted range; "pin" stops meaning pin |
| Env var as absolute pin (chosen)            | Predictable, self-documenting, matches "uncomment to pin" mental model; offset stays purely additive | Users who pin must pick ports outside every offset range they use                                |
| Error if both set                           | Safest                                                                                               | Breaks `.env` copies and CI presets; noisy for a demo repo                                       |

## Consequences

- Offset-only parallel copies work with no configuration; explicit pins are opt-in and visible.
- Tooling must resolve ports via `@xitter/config` (`localPort`) — never literal defaults. Compose receives resolved ports via a generated env file (later files win), so docker publishes and the Traefik edge shift with the offset too.
- Documentation must present the pin-vs-offset rule wherever ports are described (`.env.example`, local-setup runbook).
