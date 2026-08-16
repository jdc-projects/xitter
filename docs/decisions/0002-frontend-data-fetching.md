# ADR 0002: Frontend data fetching

## Status

Decided — 2026-08-15

## Context

The web app (Next.js server components) fetches from five backing microservices. Authentication is required for any user-generated content: unauthenticated visitors must never see user content. SEO is irrelevant (demo), but the architecture should look like something a real product would ship, and the feed's first paint should be fast.

## Decision

- Server components fetch service APIs **server-side**, forwarding the user's Keycloak session token via cookies. The web app uses OIDC authorization code flow with PKCE; the session cookie is `httpOnly`.
- Unauthenticated requests **redirect to `/login` before any user-content fetch happens** — no client-side "flash" of empty or partial content.
- The landing page and the About page are public and static; they contain no user-generated content.
- Web-to-API calls carry bearer tokens server-side; in the cluster the APIs are additionally fronted by edge JWT validation (ingress `auth_mode=oidc-api`), which validates tokens and injects identity headers.
- The web server-side fetch layer acts as a BFF-lite: browsers never talk to service APIs directly.

Rationale: SEO doesn't matter for a demo, but SSR demonstrates a realistic architecture (edge-validated APIs, server-side session forwarding) and keeps the feed's initial paint fast by rendering the first page of data on the server.

## Options

### Client-side only fetching (rejected)

- Pros: simplest mental model; no token-forwarding machinery.
- Cons: slower first paint (waterfall of client fetches); browsers would call service APIs directly (breaks the edge-auth model); less realistic.

### Full SSR with edge auth offload at Traefik for APIs (partially adopted)

- Pros: edge validation is real and used — deployed APIs do use `oidc-api` offload at the ingress.
- Cons: offloading _everything_ to the edge doesn't help the browser case; browsers still shouldn't hold broad API tokens or talk to services directly.

### BFF pattern (partially adopted)

- Pros: a dedicated BFF layer is a clean place to compose service calls.
- Cons: a separate BFF deployable duplicates what the Next.js server already is. The web server-side fetch layer is adopted as BFF-lite instead.

### Chosen: server components + session forwarding + public static landing/About

- Pros: fast first paint, realistic architecture, strict "no user content unauthenticated" guarantee enforced before rendering.
- Cons: every user route needs a server-side session check; data-fetching code must live server-side.

## Consequences

- All user-content pages require an authenticated session; the login redirect is unconditional.
- Service APIs must accept the forwarded session token in addition to edge-injected identity headers (see 0006-auth-model.md).
- Public surfaces are limited to the landing page and the About page, which stay static and cacheable.
- Web tests must cover both the authenticated render path and the unauthenticated redirect.
