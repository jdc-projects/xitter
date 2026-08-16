import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  login: null as null | { codeVerifier: string; nonce: string; next: string },
  failTake: false,
  sessionId: 'session-1',
}));

// Profile bootstrap boundary: fake SocialClient recording calls (the HTTP
// client itself is covered by api-client tests; happy-dom's fetch can't be
// stubbed transparently for workspace CJS builds).
const social = vi.hoisted(() => ({
  calls: [] as string[],
  profileExists: false,
  unreachable: false,
}));

vi.mock('@xitter/api-client', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@xitter/api-client')
  >();
  return {
    ...actual,
    SocialClient: class {
      async getProfile() {
        social.calls.push('GET');
        if (social.unreachable) throw new Error('social down');
        if (!social.profileExists) {
          throw new actual.ApiError(404, 'NOT_FOUND', 'Profile not found');
        }
        return {};
      }
      async createProfile() {
        social.calls.push('POST');
        return {};
      }
    },
  };
});

// OIDC grant and the Valkey stores are the boundaries under test - mock them;
// the real discovery/code-exchange path is covered by the e2e flow.
vi.mock('@/lib/auth/oidc', () => ({
  oidc: { authorizationCodeGrant: vi.fn() },
  oidcConfig: vi.fn(async () => ({ issuer: 'http://kc' })),
}));

vi.mock('@/lib/auth/session-store', () => ({
  valkeyStores: () => ({
    logins: {
      async take(state: string) {
        if (harness.failTake) throw new Error('valkey unavailable');
        if (state !== 'state-1') return null;
        const login = harness.login;
        harness.login = null; // getdel semantics: states are single-use
        return login;
      },
    },
    sessions: {
      async create() {
        return harness.sessionId;
      },
    },
  }),
}));

import { oidc } from '@/lib/auth/oidc';
import { GET } from './route.js';

const authorizationCodeGrantMock = vi.mocked(oidc.authorizationCodeGrant);

const originalEnv = { ...process.env };

function setBaseUrl(url: string) {
  process.env.XITTER_WEB_BASE_URL = url;
}

function callbackRequest(query = 'state=state-1&code=auth-code'): Request {
  return new Request(`http://localhost:8280/api/auth/callback?${query}`);
}

function tokenResponse() {
  return {
    access_token: 'access',
    refresh_token: 'refresh',
    id_token: 'id',
    expires_in: 900,
    claims: () => ({ sub: 'user-1', preferred_username: 'demo1' }),
  };
}

/** All Set-Cookie serialisations, joined - flag assertions run per attribute. */
function setCookies(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const combined = headers.getSetCookie?.() ?? [];
  return combined.length > 0
    ? combined.join('; ')
    : ((headers.get('set-cookie') as string | null) ?? '');
}

afterEach(() => {
  process.env = { ...originalEnv };
  harness.login = null;
  harness.failTake = false;
  authorizationCodeGrantMock.mockReset();
  vi.unstubAllGlobals();
  social.calls = [];
  social.profileExists = false;
});

describe('GET /api/auth/callback', () => {
  it('exchanges the code and sets a correctly-flagged session cookie', async () => {
    setBaseUrl('http://localhost:8280');
    harness.login = { codeVerifier: 'v', nonce: 'n', next: '/feed' };
    authorizationCodeGrantMock.mockResolvedValue(tokenResponse() as never);

    const response = await GET(callbackRequest());
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://localhost:8280/feed');

    const cookie = setCookies(response);
    expect(cookie).toContain('xitter_sid=session-1');
    expect(cookie).toContain('HttpOnly');
    // Attribute casing varies by header serializer - compare folded.
    expect(cookie.toLowerCase()).toContain('samesite=lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=43200');
    // Plain-http origin: no Secure flag (it would drop the cookie locally).
    expect(cookie).not.toContain('Secure');
  });

  it('sets the Secure flag when the public origin is https', async () => {
    setBaseUrl('https://xitter.example');
    harness.login = { codeVerifier: 'v', nonce: 'n', next: '/feed' };
    authorizationCodeGrantMock.mockResolvedValue(tokenResponse() as never);

    const response = await GET(callbackRequest());
    expect(setCookies(response)).toContain('Secure');
  });

  it('redirects to login with the preserved next when the code exchange fails', async () => {
    setBaseUrl('http://localhost:8280');
    harness.login = { codeVerifier: 'v', nonce: 'n', next: '/profile/demo2' };
    authorizationCodeGrantMock.mockRejectedValue(new Error('invalid_grant'));

    const response = await GET(callbackRequest());
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      'http://localhost:8280/login?error=callback&next=%2Fprofile%2Fdemo2',
    );
  });

  it('rejects a replayed state (single-use) without exchanging again', async () => {
    setBaseUrl('http://localhost:8280');
    harness.login = { codeVerifier: 'v', nonce: 'n', next: '/feed' };
    authorizationCodeGrantMock.mockResolvedValue(tokenResponse() as never);

    await GET(callbackRequest());
    const replay = await GET(callbackRequest());
    expect(replay.status).toBe(303);
    expect(replay.headers.get('location')).toBe('http://localhost:8280/login?error=state');
    expect(authorizationCodeGrantMock).toHaveBeenCalledTimes(1);
  });

  it('bounces to login on a store outage instead of a 500', async () => {
    setBaseUrl('http://localhost:8280');
    harness.failTake = true;

    const response = await GET(callbackRequest());
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://localhost:8280/login?error=state');
  });

  it('maps IdP error responses onto the login error page', async () => {
    setBaseUrl('http://localhost:8280');

    const response = await GET(callbackRequest('error=access_denied'));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://localhost:8280/login?error=oidc');
  });

  it('bootstraps the profile on first login (404 -> create, idempotent)', async () => {
    setBaseUrl('http://localhost:8280');
    harness.login = { codeVerifier: 'v', nonce: 'n', next: '/feed' };
    authorizationCodeGrantMock.mockResolvedValue(tokenResponse() as never);

    const response = await GET(callbackRequest());
    expect(response.status).toBe(303);
    expect(social.calls).toEqual(['GET', 'POST']);
  });

  it('skips profile creation when the profile already exists', async () => {
    setBaseUrl('http://localhost:8280');
    harness.login = { codeVerifier: 'v', nonce: 'n', next: '/feed' };
    authorizationCodeGrantMock.mockResolvedValue(tokenResponse() as never);
    social.profileExists = true;

    await GET(callbackRequest());
    expect(social.calls).toEqual(['GET']);
  });

  it('still logs in when social is unreachable (profile bootstrap is best-effort)', async () => {
    setBaseUrl('http://localhost:8280');
    harness.login = { codeVerifier: 'v', nonce: 'n', next: '/feed' };
    authorizationCodeGrantMock.mockResolvedValue(tokenResponse() as never);
    social.unreachable = true;

    const response = await GET(callbackRequest());
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://localhost:8280/feed');
  });
});
