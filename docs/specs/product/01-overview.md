# Overview

## What xitter is

xitter is a public, disposable Twitter/X-style microblog: post short text with optional images, follow accounts, read a feed of followed accounts, reply, like, bookmark, repost, search. It looks and feels like a real product, but it is explicitly a demo — every account is a shared demo account and **all data is wiped nightly** (default 00:00 UTC, configurable), optionally reseeded with a deterministic corpus.

## Why it exists

1. **Demo** — a live, clickable artifact to show the owner's build to others.
2. **Learning** — a realistic but low-stakes playground for microservices, event-driven data flow, and operational practice (resets, observability, moderation).
3. **Homelab showcase** — demonstrates a full stack (multiple services, per-service databases, object storage, search, event bus, identity provider) running on self-hosted infrastructure.

## Target audience

- The owner (primary user and operator).
- Anyone curious: visitors, friends, potential employers, other homelabbers. They arrive unauthenticated, see the landing and About page, and can log in with public demo credentials.

## Ground rules

- **No signup, no account management.** The only accounts are `demo1`..`demo10` (password `DemoPass123!`), documented on the About page.
- **Nothing is durable.** Nightly reset wipes everything; optional deterministic reseed restores a known corpus (see [../data/03-data-lifecycle.md](../data/03-data-lifecycle.md) and [../data/02-seeding.md](../data/02-seeding.md)).
- **No PII.** Prominent warnings everywhere tell users not to enter personal or sensitive data (see [../data/04-privacy.md](../data/04-privacy.md)).
- **Unauthenticated visitors** see only the landing page and the About page (which includes the FAQ section). All user-generated content requires login.

## Success criteria

| #   | Criterion                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | A full user journey works end-to-end: visit → About → login → feed → post (with image) → interact → profile → follow/block (diagram below) |
| 2   | Nightly reset + optional reseed complete cleanly; the site is usable immediately afterwards                                                |
| 3   | Docs stay current: these specs describe the product as built                                                                               |
| 4   | Observability surfaces issues before users do (traces, metrics, logs, reset-job health)                                                    |

## User journey

```mermaid
flowchart LR
    A[Visit landing page] --> B[Read About page\n(what/why, reset schedule,\ndemo credentials, FAQ)]
    B --> C[Login as demo account\n(Cap.js captcha)]
    C --> D[Feed:\nfollowed + own posts]
    D --> E[Post text + optional images]
    E --> F[Interact:\nreply / like / bookmark / repost]
    F --> G[View any profile:\nposts, following, followers]
    G --> H[Follow or block]
    H --> D
```
