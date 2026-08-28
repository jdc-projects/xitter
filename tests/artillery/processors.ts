/**
 * Artillery processors: HTTP flow hooks + browser flow functions.
 *
 * Loaded by Artillery via dynamic import, which Node runs with type
 * stripping - keep the syntax erasable (no enums/namespaces/parameter
 * properties) and dependencies to Node builtins only, so the file loads
 * from any checkout without a build step.
 *
 * `loginDemo` rotates the seeded demo users (demo1..demoN) instead of
 * authenticating every VU as one user: the per-user+IP rate limiter
 * (capacity 20, refill 1/s on mutation routes) then sees spread load and
 * the create-post scenario stops self-throttling with 429s (#158).
 * Password-grant tokens are cached per user until 30s before expiry -
 * repeat iterations reuse them instead of hammering Keycloak.
 */

import http from 'node:http';
import type { Page } from '@playwright/test';

const keycloak =
  process.env.XITTER_KEYCLOAK_URL ?? process.env.KEYCLOAK_URL ?? 'http://localhost:8090';
const realm = process.env.XITTER_DEMO_REALM ?? 'xitter-demo';
const password = process.env.XITTER_DEMO_USER_PASSWORD ?? 'DemoPass123!';

/** Seeded corpus users (XITTER_DEMO_USER_PREFIX/COUNT, defaults demo1..demo10). */
const demoUsers = buildDemoUsers();

function buildDemoUsers(): string[] {
  const prefix = process.env.XITTER_DEMO_USER_PREFIX ?? 'demo';
  const raw = Number.parseInt(process.env.XITTER_DEMO_USER_COUNT ?? '10', 10);
  const count = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 50) : 10;
  return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);
}

/** Round-robin cursor per worker process - spreads VUs across users. */
let rotationCursor = 0;

export function nextDemoUser(): string {
  const user = demoUsers[rotationCursor % demoUsers.length]!;
  rotationCursor += 1;
  return user;
}

interface ArtilleryContext {
  vars: Record<string, unknown>;
}

interface ArtilleryEvents {
  emit: (name: string, payload?: unknown) => void;
}

type Done = (err?: unknown) => void;

/** token cache: username -> in-flight promise or cached token with expiry */
const tokens = new Map<string, Promise<string> | { token: string; expiresAt: number }>();

export function loginDemo(
  context: ArtilleryContext,
  events: ArtilleryEvents,
  done: Done,
): void {
  const username = nextDemoUser();
  token(username)
    .then((t) => {
      context.vars.token = t;
      done();
    })
    .catch((err) => {
      events.emit('error', err);
      done(err);
    });
}

function token(username: string): Promise<string> {
  const cached = tokens.get(username);
  if (cached && 'token' in cached) {
    if (cached.expiresAt > Date.now() + 30_000) {
      return Promise.resolve(cached.token);
    }
    // Expired (or expiring within 30s) - fall through to a fresh grant.
  } else if (cached) {
    // In-flight grant for this user - piggyback instead of stampeding Keycloak.
    return cached;
  }
  const pending = passwordGrant(username)
    .then((t) => {
      tokens.set(username, { token: t, expiresAt: tokenExpiry(t) });
      return t;
    })
    .catch((err) => {
      tokens.delete(username);
      throw err;
    });
  tokens.set(username, pending);
  return pending;
}

/** Seconds-since-epoch expiry from the JWT payload; 0 when unparseable. */
function tokenExpiry(token: string): number {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function passwordGrant(username: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: 'web',
    username,
    password,
  }).toString();

  return new Promise((resolve, reject) => {
    const req = http.request(
      `${keycloak}/realms/${realm}/protocol/openid-connect/token`,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as { access_token?: string; error?: string };
            if (parsed.access_token) {
              resolve(parsed.access_token);
            } else {
              reject(new Error(`token grant failed for ${username}: ${parsed.error ?? data}`));
            }
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/*
 * Browser flows (Artillery Playwright engine). The engine resolves flow
 * functions from this module - `testMatch` is not a thing in Artillery
 * 2.0.x, so these live here rather than in a separate spec-style file.
 */

/** Artillery's `test` helper: times the actions and emits `browser.step.<name>`. */
interface StepHelper {
  step: (name: string, userActions: () => Promise<void>) => Promise<void>;
}

/** Public surfaces: landing page + the CMS-backed About page. */
export async function publicBrowseFlow(
  page: Page,
  _context: ArtilleryContext,
  _events: ArtilleryEvents,
  test: StepHelper,
): Promise<void> {
  await test.step('landing', async () => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('demo-credentials').waitFor();
  });
  await test.step('about', async () => {
    await page.goto('/about', { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { level: 1, name: 'About' }).waitFor();
  });
}

/** The core journey: Keycloak login -> feed -> post detail. */
export async function authedJourneyFlow(
  page: Page,
  _context: ArtilleryContext,
  _events: ArtilleryEvents,
  test: StepHelper,
): Promise<void> {
  const username = nextDemoUser();
  const keycloakUrl = new RegExp(`/realms/${realm}/`);

  await test.step('login', async () => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('login-submit').click();
    await page.waitForURL(keycloakUrl);
    await page.locator('#username').fill(username);
    await page.locator('#password').fill(password);
    await page.locator('#kc-login').click();
    await page.waitForURL(/\/feed$/);
  });
  await test.step('feed', async () => {
    // Assert real content, not just a 200: a broken feed renders the
    // feed-error alert and must fail the flow (and the error budget).
    await page.getByTestId('feed-timeline').waitFor();
    await page.locator('a[href^="/post/"]').first().click();
  });
  await test.step('post', async () => {
    await page.locator('[data-testid^="post-detail-"]').first().waitFor();
  });
}
