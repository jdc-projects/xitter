# Content Guidelines

Site content strategy: what text lives where, in what tone, and the non-negotiable warning copy. Feature behaviour is specified in [02-features.md](./02-features.md).

## CMS vs code

| Content                                  | Lives in | Notes                                                                                                                                                                            |
| ---------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| About intro sections (what/why/how)      | CMS      | Ordered, editable, live preview; slugs double as anchors (#153 — moved from the landing intro)                                                                                   |
| FAQ entries                              | CMS      | Ordered list, editable, live preview                                                                                                                                             |
| Standalone pages (e.g. the changelog)    | CMS      | One `pages` doc per public page rendered at `/<slug>`: kebab-case slug (fixed routes are rejected), title, meta description, ordered body sections; live preview (#215)          |
| Landing value prop                       | Code     | One line, code-owned — the front door does not explain the app (#153)                                                                                                            |
| Page shells, navigation, labels, buttons | Code     | Product UI is not CMS-editable                                                                                                                                                   |
| Reset notice / PII warning _wording_     | Code     | Shown on every required surface; must not be accidentally editable away                                                                                                          |
| Under-the-hood stack facts               | Code     | Facts about the deployed platform (services, workers, stores, IaC) - code-rendered on the About page so they cannot drift from reality; the CMS sections stay the editable prose |

Rule of thumb: _prose about the site_ is CMS; _the product itself_ is code. Anything that must survive the nightly reset and be version-controlled is promoted from CMS back to repo seed files (see [../data/02-seeding.md](../data/02-seeding.md)).

## Rendering and resilience

The web app SSR-fetches the About intro sections and FAQ entries from the Payload REST API (`/api/about-content`, `/api/faq`, ordered by `order`), with:

- **Hardcoded code fallbacks** whenever the CMS is unreachable, erroring, or empty — the About page must never fail because the CMS is down (demo resilience beats freshness). The landing page no longer fetches CMS content at all (#153).
- **Caching**: published content rides the Next data cache with a short revalidate + tags; draft renders (`?preview=` param, live preview) are per-request and never cached.
- **Draft access**: the CMS API itself gates `?draft=true` behind an authenticated CMS principal (admin session or the `cms` service client). The web's preview URL is deliberately **not** further gated (accepted exposure, demo threat model): anyone holding a `?preview=` link can read the current drafts of site copy (pre-publication marketing/FAQ text only — no user data). Never publish sensitive copy through the CMS drafts.

CMS pages (`pages` collection) render at `/<slug>` through a dynamic route (#215) with the same caching and draft rules, but **no hardcoded fallback**: arbitrary pages have no code-owned copy, so an unknown, unpublished or unreachable page simply 404s. A page slug must never collide with a fixed route (`about`, `login`, `feed`, `post`, `profile`, `search`, `bookmarks`, `api`, `media`, `cms`, `admin`, `healthz`, `readyz`) — the CMS rejects reserved slugs at save time and the web route refuses them as defence in depth, so a CMS page can never shadow (or be shadowed by) a fixed route.

## Tone

Light, clear, honest. The copy never pretends xitter is a real social network — it says plainly that this is a demo built to showcase a microservices homelab. Short sentences, no marketing fluff, occasional dry humour welcome. British-lean spelling consistent throughout.

## Reset + PII warnings (required copy)

Both warnings must appear on **landing, login, and the About page** — no exceptions. Requirements:

| Requirement | Reset warning                                                                   | PII warning                                                                                                |
| ----------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Placement   | Above the fold / pre-login                                                      | Adjacent to every input that accepts user text (post composer, bio editor) and on the three required pages |
| Must state  | All data is wiped nightly, default 00:30 UTC, reseed may restore a fixed corpus | Do not enter personal or sensitive data — anyone can read it and nothing is retained                       |
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

- Credentials (`demo1`..`demo10` / `DemoPass123!`) are **public by design**; they appear on the landing page (demo-credentials entry point), the About page and the login page.
- Never imply the accounts are private or secure; anyone can be any demo user at any time.
- Copy should set expectations: shared accounts, shared data, zero privacy between demo users (except bookmarks, which are private per the product spec).
- There is no signup, invitation, or account management to communicate — state that once, plainly, and move on.
