# Content Guidelines

Site content strategy: what text lives where, in what tone, and the non-negotiable warning copy. Feature behaviour is specified in [02-features.md](./02-features.md).

## CMS vs code

| Content                                  | Lives in | Notes                                                                   |
| ---------------------------------------- | -------- | ----------------------------------------------------------------------- |
| Landing intro                            | CMS      | Short, editable, live preview                                           |
| FAQ entries                              | CMS      | Ordered list, editable, live preview                                    |
| Page shells, navigation, labels, buttons | Code     | Product UI is not CMS-editable                                          |
| Reset notice / PII warning _wording_     | Code     | Shown on every required surface; must not be accidentally editable away |

Rule of thumb: _prose about the site_ is CMS; _the product itself_ is code. Anything that must survive the nightly reset and be version-controlled is promoted from CMS back to repo seed files (see [../data/02-seeding.md](../data/02-seeding.md)).

## Rendering and resilience

The web app SSR-fetches landing intro and FAQ entries from the Payload REST API (`/api/landing-content`, `/api/faq`, ordered by `order`), with:

- **Hardcoded code fallbacks** whenever the CMS is unreachable, erroring, or empty — the landing and About pages must never fail because the CMS is down (demo resilience beats freshness).
- **Caching**: published content rides the Next data cache with a short revalidate + tags; draft renders (`?preview=` param, live preview) are per-request and never cached.
- **Drafts are auth-gated**: published content is world-readable; `?draft=true` requires an authenticated CMS principal (admin browser session or the `cms` service client).

## Tone

Light, clear, honest. The copy never pretends xitter is a real social network — it says plainly that this is a demo built to showcase a microservices homelab. Short sentences, no marketing fluff, occasional dry humour welcome. British-lean spelling consistent throughout.

## Reset + PII warnings (required copy)

Both warnings must appear on **landing, login, and the About page** — no exceptions. Requirements:

| Requirement | Reset warning                                                                   | PII warning                                                                                                |
| ----------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Placement   | Above the fold / pre-login                                                      | Adjacent to every input that accepts user text (post composer, bio editor) and on the three required pages |
| Must state  | All data is wiped nightly, default 00:00 UTC, reseed may restore a fixed corpus | Do not enter personal or sensitive data — anyone can read it and nothing is retained                       |
| Must be     | Unmissable (landing: prominent banner, not fine print)                          | Unmissable on the composer                                                                                 |

Exact wording may vary by surface, but every instance must cover the points above.

## FAQ content (About page)

The FAQ section on the About page covers, at minimum:

1. What is this? (Twitter/X-style demo of a microservices homelab)
2. Why does the data disappear? (Nightly reset, schedule, optional reseed)
3. How do I log in? (Demo accounts, public by design)
4. Can I get an account? (No signup — demo accounts only)
5. What shouldn't I post? (PII/sensitive data — see privacy posture, [../data/04-privacy.md](../data/04-privacy.md))
6. Who runs this / where's the code? (The owner; link out as appropriate)
7. Something looks broken — is that you? (It's a demo; observability + resets keep it healthy)

Entries are CMS-managed and promotable to seed content: committed under `packages/scripts/data/content/` keyed by a stable `slug`, applied idempotently by the seeder after every reset (runbook [../runbooks/03-promoting-demo-content.md](../runbooks/03-promoting-demo-content.md)).

## Demo account communication policy

- Credentials (`demo1`..`demo10` / `DemoPass123!`) are **public by design** and listed on the About page.
- Never imply the accounts are private or secure; anyone can be any demo user at any time.
- Copy should set expectations: shared accounts, shared data, zero privacy between demo users (except bookmarks, which are private per the product spec).
- There is no signup, invitation, or account management to communicate — state that once, plainly, and move on.
