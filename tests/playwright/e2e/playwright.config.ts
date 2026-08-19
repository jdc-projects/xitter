// E2E suite: runs against the full stack via the edge proxy (prod-like mode,
// started automatically). Covers user flows end-to-end, including a11y.
import { defineConfig } from '@playwright/test';
import { loadRepoEnv, localPort } from '@xitter/config';

loadRepoEnv();

const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${localPort('edge')}`;

// XITTER_BROWSER_PATH opts out of the Playwright download entirely (CI
// runners ship Chrome preinstalled; the CDN download has stalled for hours
// at a time). Same engine family, so test semantics are unchanged.
const executablePath = process.env.XITTER_BROWSER_PATH || undefined;

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL,
    executablePath,
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
    url: `http://localhost:${localPort('web')}`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
  reporter: [['list'], ['html', { outputFolder: 'tests/playwright/e2e/report', open: 'never' }]],
});
