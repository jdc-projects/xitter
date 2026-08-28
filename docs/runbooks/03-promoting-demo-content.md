# Runbook 03: Promoting demo content

## Context

Deployed environments reset nightly (full data reset at 00:30 UTC). Content authored in a deployed environment — CMS edits, seed tweaks made while demoing — is disposable unless it is promoted back to the repo, where the deterministic reseed can reproduce it.

Only CMS-managed site content participates (About sections, FAQ entries — spec [product 04](../specs/product/04-content-guidelines.md)); user posts are never promoted. Content is keyed by the unique `slug` field on both collections: promotion upserts by slug, so ids can differ freely between environments.

## Execution steps

1. **Export CMS content** from the deployed environment:

   ```sh
   XITTER_SEED_BASE_URL=https://<env-domain> \
   XITTER_SEED_KEYCLOAK_URL=https://idp.jd-chapman.dev \
   XITTER_ADMIN_REALM=<primary-realm> \
   XITTER_CMS_CLIENT_SECRET=<secret> \
     npm run content:export
   ```

   The script fetches **published** content only (drafts stay in the CMS) through the edge (`/cms/api/*`) using a client-credentials token for the `cms` client — its service account carries `app-admin`. Output is deterministic (ordered by `order`, stable key order), so re-exporting unchanged content produces no diff.

2. **Review + commit the export**: `packages/scripts/data/content/about-content.json` and `faq.json`. Re-running an export and committing over the previous files is the expected update path — never edit the JSON by hand when a live CMS holds the truth.

3. **No seed-mapping step needed**: `npm run seed` (and the nightly reset's reseed via the shared `applyCmsContent` seam) upserts the content files automatically — keyed on `slug`, publishing immediately (`draft=false`), never touching the deterministic faker corpus.

4. **Verify locally**: with the stack up (`npm run dev` or `npm run start` + deps), run `npm run content:apply`, then check the About page renders the promoted copy.

5. **Raise a PR to `dev`** — run `npm run check` first; CI re-runs the gates.

## Validation steps

1. Reset the environment (trigger the reset job or wait for the nightly reset at 00:30 UTC).
2. Confirm the promoted content is present after reseed — via the site (About page) or `GET /cms/api/about-content`.
3. If content is missing, re-check that the PR merged to the environment's deploy branch (`dev` for xitter-dev) and that the seed files parse (`npm run content:apply` fails loudly on malformed JSON).
