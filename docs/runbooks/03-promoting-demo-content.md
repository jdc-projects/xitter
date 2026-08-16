# Runbook 03: Promoting demo content

## Context

Deployed environments reset nightly (full data reset at 00:00 UTC). Content authored in a deployed environment — CMS edits, seed tweaks made while demoing — is disposable unless it is promoted back to the repo, where the deterministic reseed can reproduce it.

## Execution steps

1. **Export CMS content** from the deployed environment, either:
   - via the Payload REST API using an admin token, or
   - via the Payload CLI dump.
2. **Commit the export** as content seed files (JSON/CSV) under `packages/scripts/data/` — create the directory if it doesn't exist yet.
3. **Extend the seed mapping** in `packages/scripts/src/seed.ts` so `npm run seed` loads the content files (keep the deterministic faker seed intact — promoted content should not change randomised data).
4. **Verify locally**: `npm run seed` against a local (reset) environment, then diff the result against the deployed content.
5. **Raise a PR to `dev`** — run `npm run check` first; CI re-runs the gates.

Steps 1–2 are repeatable; re-running an export and committing over the previous files is the expected update path.

## Validation steps

1. Reset the environment (trigger the reset job or wait for the nightly reset at 00:00 UTC).
2. Confirm the promoted content is present after reseed — via the CMS admin UI or the site itself.
3. If content is missing, re-check the `seed.ts` mapping and that the PR merged to the environment's deploy branch (`dev` for xitter-dev).
