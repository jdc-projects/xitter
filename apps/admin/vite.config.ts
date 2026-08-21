import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { loadRepoEnv, localPort, localUrl } from '@xitter/config';

// The SPA has no server runtime, so IdP coordinates are resolved here (Node
// context, env-driven like every other app) and baked into the bundle. The
// redirect origin itself is runtime (window.location.origin) so the same
// build works through the edge and against the dev server.
loadRepoEnv();

const keycloakUrl = process.env.XITTER_KEYCLOAK_URL ?? localUrl('keycloak');
const adminRealm = process.env.XITTER_ADMIN_REALM ?? 'xitter-local-admin';

export default defineConfig({
  plugins: [react()],
  // The edge does NOT strip /admin; the app serves under this base to match.
  base: '/admin/',
  build: { outDir: 'dist' },
  define: {
    __XITTER_KEYCLOAK_URL__: JSON.stringify(keycloakUrl),
    __XITTER_ADMIN_REALM__: JSON.stringify(adminRealm),
    // localPort is offset-aware (XITTER_PORT_OFFSET), matching how the
    // workers themselves bind their metrics listeners locally.
    __XITTER_WORKER_METRICS_PORTS__: JSON.stringify({
      fanout: localPort('fanoutMetrics'),
      'media-process': localPort('mediaProcessMetrics'),
      'search-index': localPort('searchIndexMetrics'),
    }),
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    globals: true,
  },
});
