# Privacy

Privacy by design for a public demo with shared accounts. The product collects **no PII**, and the nightly reset is the ultimate erasure. Product-facing warning copy requirements: [../product/04-content-guidelines.md](../product/04-content-guidelines.md).

## No PII collection

- The only accounts are the synthetic demo users (`demo1`..`demo10`) in the Keycloak demo realm — synthetic identities, no real names or emails.
- Product code stores no emails, real names, addresses, phone numbers, or identifiers beyond the synthetic profile fields (`displayName`, `bio`).
- Login requires only the public demo credentials; there is nothing personal to authenticate with.

## User-entered content caveats

Post text, images, replies, bios, and display names are user-entered, and users _can_ type PII despite the warnings. Mitigations, in order:

1. **Warn prominently** — reset + PII warnings on landing, login, and the About page, plus adjacent to every free-text input (composer, bio editor). Copy requirements are normative in [../product/04-content-guidelines.md](../product/04-content-guidelines.md).
2. **Ephemeral by design** — everything user-entered is wiped nightly ([03-data-lifecycle.md](./03-data-lifecycle.md)).
3. **Moderation** — the admin panel can delete offending posts/media on sight.
4. **Public-by-design accounts** — copy sets the expectation that demo accounts are shared, so nothing typed is private anyway (bookmarks are the only per-user-private surface).

## What "no PII" means operationally

| Rule                                             | Enforcement                                                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| No emails/names/addresses stored by product code | Schemas carry only synthetic fields ([01-storage-model.md](./01-storage-model.md)); PR review rejects additions |
| Logs must not log post bodies or media bytes     | Log ids (postId, userId, mediaId), counts, and statuses only                                                    |
| Logs must not log tokens or credentials          | Auth tokens/cookies never appear in log output                                                                  |
| Errors/messages must not echo user content       | Failure responses carry codes/ids, not the submitted text                                                       |

## Reset as the ultimate erasure

The nightly wipe ([03-data-lifecycle.md](./03-data-lifecycle.md)) is the privacy guarantee: truncates every service DB, wipes the media bucket, deletes search indices, resets consumer groups, and recreates the Keycloak demo realm. After a reset, no user-entered data exists anywhere in the running system.

## Backups excluded

- Service DBs, RustFS, OpenSearch, and the demo realm are **excluded from backups** — wiped data cannot return.
- Backups (if any exist) cover durable artifacts only: repo content (code, seed files, IaC), which by construction contain no user data.
- Disaster recovery for user data is explicitly _not_ a goal; the reseed corpus is the only "recovery" and contains only synthetic/promoted content.

## Keycloak demo realm

- Contains only the synthetic demo accounts; recreated at every reset.
- No self-registration, no profile enrichment, no external identity federation — nothing real can leak in via identity.
