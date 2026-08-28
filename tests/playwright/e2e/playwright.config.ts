// E2E suite: runs against the full stack via the edge proxy (prod-like mode,
// started automatically). Covers user flows end-to-end, including a11y.
import { defineConfig, devices } from '@playwright/test';
import { loadRepoEnv, localPort } from '@xitter/config';

loadRepoEnv();

const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${localPort('edge')}`;

// XITTER_BROWSER_PATH opts out of the Playwright download entirely (CI
// runners ship Chrome preinstalled; the CDN download has stalled for hours
// at a time). Same engine family, so test semantics are unchanged.
const executablePath = process.env.XITTER_BROWSER_PATH || undefined;

/**
 * iPhone-class device emulation on Chromium (#151). The device descriptors
 * carry `defaultBrowserType: 'webkit'`, but CI (and the no-cross-browser
 * rule, testing spec 03) ships Chromium only - strip the browser hint and
 * keep the viewport/touch/isMobile emulation.
 */
function chromiumDevice<T extends { defaultBrowserType?: string }>(device: T) {
  const { defaultBrowserType: _webkit, ...emulation } = device;
  return emulation;
}

// Mobile matrix (#151): the core journey specs re-run at iPhone 13
// (390x844); iPhone SE (375x667) is the 320px-class geometry guard - nav +
// the overflow spec - not a second concurrent pass over the stateful flow
// specs (they share fixed demo accounts, and two device projects racing
// them against one stack fight over follow/block edges).
const MOBILE_MATCH = /(nav|feed-flow|post-flow|profile|search-flow|mobile)\.spec\.ts/;
const MOBILE_SE_MATCH = /(nav|mobile)\.spec\.ts/;

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
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
      testIgnore: /(a11y|mobile)\.spec\.ts/,
    },
    // A11y runs in its own project to keep the main flow matrix fast.
    // The unanchored match covers admin-a11y.spec.ts as well.
    { name: 'a11y', use: { browserName: 'chromium' }, testMatch: /(a11y|admin-a11y)\.spec\.ts/ },
    {
      name: 'mobile',
      use: { ...chromiumDevice(devices['iPhone 13']) },
      testMatch: MOBILE_MATCH,
    },
    {
      // The 320px-class guard (#151): nav behaviour + the horizontal
      // overflow spec at iPhone SE width. Deliberately NOT the flow specs -
      // see MOBILE_SE_MATCH above.
      name: 'mobile-se',
      use: { ...chromiumDevice(devices['iPhone SE']) },
      testMatch: MOBILE_SE_MATCH,
    },
    {
      // The axe set re-scanned at an iPhone-class viewport (#151) - where
      // WCAG 2.5.8 target-size actually bites. The admin panel (desktop-first
      // antd tables) is covered by the desktop a11y project only - the
      // path-boundary anchor excludes admin-a11y.spec.ts (a plain substring
      // would match it too).
      name: 'a11y-mobile',
      use: { ...chromiumDevice(devices['iPhone 13']) },
      testMatch: /(^|\/)a11y\.spec\.ts$/,
    },
  ],
  webServer: {
    // Stack wrapper: starts `npm run start`, waits for services AND the
    // workers, applies the deterministic seed (idempotent), then idles -
    // the suite expects a seeded, lived-in environment (T13).
    // Playwright runs the command from the CONFIG dir; npm-walk-up makes
    // the web suite's command work from there, but tsx resolves its entry
    // literally - anchor to the repo root.
    command: 'tsx packages/scripts/src/e2e-stack.ts',
    cwd: '../../../',
    // Probe the stackProbe port, NOT the web app - the wrapper answers
    // there only after the seed has landed. Gating on the web port let
    // tests start mid-seed: first-logins bootstrap stub profiles that
    // trip the seeder's partial-corpus guard. (The edge port is even
    // worse: traefik holds it open whenever the docker stack is up.)
    url: `http://localhost:${localPort('stackProbe')}`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
  reporter: [['list'], ['html', { outputFolder: 'tests/playwright/e2e/report', open: 'never' }]],
});
