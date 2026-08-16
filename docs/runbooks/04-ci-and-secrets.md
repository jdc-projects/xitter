# CI and Secrets Setup

One-time setup for GitHub Actions (tofu in CI, Cap.js captcha keys) and the
cluster kubeconfig. Everything here is idempotent - re-running is safe.

## Context

CI runs OpenTofu against the homelab cluster (`tofu` validate job on every PR,
`tofu-plan` on infra changes, `tofu-apply` on merge to `dev`). The cluster
kubeconfig is the single secret required; Cap.js site credentials are created in
the Cap dashboard and stored as repo secrets for the auth ticket (#3) and Tofu
(dev environment ingress/realms).

## Execution steps

### 1. Cluster kubeconfig (required for tofu CI)

```sh
gh secret set CLUSTER_KUBECONFIG < /path/to/homelab/iac/cluster.yml
```

CI writes this to `infra/cluster.yml` before every tofu init/plan/apply - the
same path the env configs resolve locally. Local tofu runs use the same file
(gitignored).

### 2. Cap.js captcha site (required for #3 / T2 auth)

1. Retrieve the Cap admin key from the cluster:

   ```sh
   kubectl -n cap get secret cap-env -o jsonpath='{.data.ADMIN_KEY}' | base64 -d
   ```

2. Log in at https://cap.jd-chapman.dev (homelab Keycloak SSO, then paste the
   ADMIN_KEY when prompted).
3. Create a site named `xitter`.
4. On the site's **Configuration** tab, set CORS origins to the exact origins
   (Cap matches strings literally - no wildcards):
   - `http://localhost:8080` (local edge, default port)
   - `https://xitter-dev.jd-chapman.dev` (dev)
   - `https://xitter.jd-chapman.dev` (prod)
5. Copy the site's **site key** and **secret key**, then:

   ```sh
   gh secret set XITTER_CAP_SITE_KEY
   gh secret set XITTER_CAP_SECRET_KEY
   ```

6. For local runs, add the same values to `.env`:

   ```sh
   XITTER_CAP_SITE_KEY=<site key>
   XITTER_CAP_SECRET_KEY=<secret key>
   XITTER_CAP_ENABLED=true
   ```

   Captcha-enabled local runs assume the default edge port (8080) - the local
   origin in the site's CORS list. For an offset copy, either keep captcha
   disabled or add that copy's origin to the site first.

## Validation steps

1. `gh secret list` shows `CLUSTER_KUBECONFIG`, `XITTER_CAP_SITE_KEY`,
   `XITTER_CAP_SECRET_KEY`.
2. Open a PR touching `infra/iac/**` - the `tofu-plan` job runs and plans
   against the real backend.
3. From a checkout with `infra/cluster.yml` present:
   `cd infra/iac/environments/dev && tofu init && tofu plan` succeeds locally
   too (same state, same backend).

## Notes

- Sentry/Grafana/Prometheus need no secrets here: xitter consumes them via
  Tofu remote state (`infra/iac/REMOTE-STATE.md`) and pushes its own CRs.
- Everything else (image pushes) uses the built-in `GITHUB_TOKEN`.
