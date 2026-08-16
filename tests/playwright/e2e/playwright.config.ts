// E2E suite: runs against the full stack via the edge proxy (prod-like mode,
// started automatically). Covers user flows end-to-end, including a11y.
import { defineConfig } from '@playwright/test';

const port = process.env.XITTER_EDGE_PORT ?? '8080';
const webPort = process.env.XITTER_WEB_PORT ?? '3456';
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${port}`;

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' }, testIgnore: /a11y\.spec\.ts/ },
    // A11y runs in its own project to keep the main flow matrix fast.
    { name: 'a11y', use: { browserName: 'chromium' }, testMatch: /a11y\.spec\.ts/ },
  ],
  webServer: {
    command: 'npm run start',
    // Probe the web app port, NOT the edge (:8080) - traefik holds the edge
    // open whenever the docker stack is up, which would falsely signal ready
    // and skip starting the apps under test.
    url: `http://localhost:${webPort}`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
  reporter: [['list'], ['html', { outputFolder: 'tests/playwright/e2e/report', open: 'never' }]],
});
