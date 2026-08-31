import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { loadRepoEnv, localPort, localUrl } from '@xitter/config';

// The SPA has no server runtime, so IdP coordinates are resolved here (Node
// context, env-driven like every other app) and baked into the bundle. The
// redirect origin itself is runtime (window.location.origin) so the same
// build works through the edge and against the dev server.
loadRepoEnv();

// Docker build-args arrive via ENV and may be EMPTY strings when unset (an
// empty ENV still beats `??`), so blank values fall through to the local
// fallbacks - `npm run dev` and a plain `docker build` stay identical.
const envOrUndefined = (value: string | undefined): string | undefined =>
  value && value.trim() ? value : undefined;

const keycloakUrl = envOrUndefined(process.env.XITTER_KEYCLOAK_URL) ?? localUrl('keycloak');
const adminRealm = envOrUndefined(process.env.XITTER_ADMIN_REALM) ?? 'xitter-local-admin';
// The deployed client ids are env-distinct (ADR 0012: the primary realm is
// shared, so dev/prod must never declare the same client); local keeps the
// id the bootstrap script creates in the local admin realm.
const adminClientId = envOrUndefined(process.env.XITTER_ADMIN_CLIENT_ID) ?? 'admin-panel';

// Homelab Grafana carries the dashboards for BOTH deployed envs; local dev
// renders the scrape-port copy instead, so the fallback never surfaces in
// the UI.
const grafanaUrl =
  envOrUndefined(process.env.XITTER_GRAFANA_URL) ?? 'https://grafana.jd-chapman.dev';

export default defineConfig({
  plugins: [react()],
  // The edge does NOT strip /admin; the app serves under this base to match.
  base: '/admin/',
  build: { outDir: 'dist' },
  define: {
    __XITTER_KEYCLOAK_URL__: JSON.stringify(keycloakUrl),
    __XITTER_ADMIN_REALM__: JSON.stringify(adminRealm),
    __XITTER_ADMIN_CLIENT_ID__: JSON.stringify(adminClientId),
    // localPort is offset-aware (XITTER_PORT_OFFSET), matching how the
    // workers themselves bind their metrics listeners locally.
    __XITTER_WORKER_METRICS_PORTS__: JSON.stringify({
      fanout: localPort('fanoutMetrics'),
      'media-process': localPort('mediaProcessMetrics'),
      'search-index': localPort('searchIndexMetrics'),
    }),
    __XITTER_GRAFANA_URL__: JSON.stringify(grafanaUrl),
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    globals: true,
  },
});
