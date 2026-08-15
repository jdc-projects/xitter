# ADR 0007: Frontend UI library

## Status

Decided — 2026-08-15

## Context

The project brief specifies Mantine for the web frontend. We still need to decide how strictly to lean on it versus adding other styling approaches, how to format times (the product uses relative-under-24h timestamps), and where shared product components live.

## Decision

- **Mantine 9** with CSS-layer styles is the styling system.
- **Mantine component props over custom CSS** — a repo rule. Minimal CSS files; reach for component props first, custom CSS only where Mantine genuinely can't express it.
- **dayjs** for time formatting (including the relative `<24h`, rounded to most significant figure, else absolute timestamp rule).
- **Tabler icons** via `@tabler/icons-react`.
- **`@xitter/ui`** shared package for product components: `PostCard`, `RelativeTime`, `UserAvatar`, `ResetNotice`.

## Options

| Option                                               | Pros                                                                                                                  | Cons                                                                                     | Verdict    |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------- |
| Tailwind + headless UI                               | Utility flexibility                                                                                                   | Brief specifies Mantine; two styling mental models                                       | Rejected   |
| CSS modules                                          | Scoped, framework-agnostic                                                                                            | Pushes against the prop-driven styling preference; more files, less consistency          | Rejected   |
| **Mantine props-first + shared ui package (chosen)** | Matches brief; consistent look for free; product components (`PostCard`, `RelativeTime`, etc.) reused across surfaces | Occasional fights with Mantine's defaults; discipline needed to avoid CSS escape hatches | **Chosen** |

## Consequences

- Code review enforces "props over CSS"; `lint:repo` (react-doctor) backs this up at the repo level.
- Time formatting logic lives in one place (`RelativeTime` in `@xitter/ui`), so the relative/absolute rule can't drift between surfaces.
- The nightly-reset warning (`ResetNotice`) is a shared component because it appears across the product (no PII, disposable data messaging).
- Upgrading Mantine majors is a coordinated change across web and `@xitter/ui`.
