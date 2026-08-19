// Isolated web suite: runs against ONLY the web frontend (no backend services).
// Mocked service responses keep these tests deterministic and fast.
import { defineConfig } from '@playwright/test';
import { loadRepoEnv, localPort } from '@xitter/config';

loadRepoEnv();

const baseURL = process.env.WEB_BASE_URL ?? `http://localhost:${localPort('web')}`;

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL,
    // XITTER_BROWSER_PATH opts out of the Playwright download (CI ships
    // Chrome preinstalled; the CDN has stalled for hours at a time).
    executablePath: process.env.XITTER_BROWSER_PATH || undefined,
    // Deterministic clocks where the app supports them; component-level time
    // assertions happen in unit tests.
  },
  webServer: {
    // Test tooling starts prod-like mode automatically (built artifacts).
    command: 'npm run build --workspace web && npm run start --workspace web',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  reporter: [['list'], ['html', { outputFolder: 'tests/playwright/web/report', open: 'never' }]],
});
