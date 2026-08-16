import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStores } from './session-store.js';

// The session module consumes openid-client only through ./oidc.js - mock
// that boundary; the real discovery/grant code is covered by the e2e flow.
vi.mock('./oidc.js', () => ({
  oidc: {
    refreshTokenGrant: vi.fn(),
  },
  oidcConfig: vi.fn(async () => ({ issuer: 'http://kc' })),
}));

import { oidc } from './oidc.js';
import { resolveSession, sanitizeNextPath } from './session.js';

const refreshTokenGrantMock = vi.mocked(oidc.refreshTokenGrant);

function tokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    id_token: 'new-id',
    expires_in: 900,
    claims: () => ({ sub: 'user-1', preferred_username: 'demo1' }),
    ...overrides,
  };
}

let clockNow = 1_786_497_600_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-16T12:00:00Z'));
  clockNow = Date.now();
  refreshTokenGrantMock.mockReset();
});

describe('resolveSession', () => {
  it('returns the stored session while the access token is fresh', async () => {
    const { sessions } = memoryStores();
    const id = await sessions.create({
      subject: 'user-1',
      username: 'demo1',
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: clockNow + 600_000,
    });

    await expect(resolveSession(sessions, id)).resolves.toMatchObject({
      id,
      subject: 'user-1',
      username: 'demo1',
      accessToken: 'access',
    });
    expect(refreshTokenGrantMock).not.toHaveBeenCalled();
  });

  it('returns null without a session id or record', async () => {
    const { sessions } = memoryStores();
    await expect(resolveSession(sessions, undefined)).resolves.toBeNull();
    await expect(resolveSession(sessions, 'missing')).resolves.toBeNull();
  });

  it('silently refreshes an expired access token and persists it', async () => {
    const { sessions } = memoryStores();
    const id = await sessions.create({
      subject: 'user-1',
      username: 'demo1',
      accessToken: 'stale-access',
      refreshToken: 'old-refresh',
      expiresAt: clockNow - 1_000,
    });
    refreshTokenGrantMock.mockResolvedValue(tokenResponse() as never);

    await expect(resolveSession(sessions, id)).resolves.toMatchObject({
      accessToken: 'new-access',
    });
    expect(refreshTokenGrantMock).toHaveBeenCalledWith(expect.anything(), 'old-refresh');

    const stored = await sessions.get(id);
    expect(stored?.accessToken).toBe('new-access');
    expect(stored?.refreshToken).toBe('new-refresh');
  });

  it('keeps the previous refresh token when the response omits one', async () => {
    const { sessions } = memoryStores();
    const id = await sessions.create({
      subject: 'user-1',
      username: 'demo1',
      accessToken: 'stale-access',
      refreshToken: 'reused-refresh',
      expiresAt: clockNow - 1_000,
    });
    refreshTokenGrantMock.mockResolvedValue(tokenResponse({ refresh_token: undefined }) as never);

    await expect(resolveSession(sessions, id)).resolves.toMatchObject({
      accessToken: 'new-access',
    });
    expect((await sessions.get(id))?.refreshToken).toBe('reused-refresh');
  });

  it('destroys the session when the refresh token is rejected', async () => {
    const { sessions } = memoryStores();
    const id = await sessions.create({
      subject: 'user-1',
      username: 'demo1',
      accessToken: 'stale-access',
      refreshToken: 'revoked-refresh',
      expiresAt: clockNow - 1_000,
    });
    refreshTokenGrantMock.mockRejectedValue(new Error('invalid_grant'));

    await expect(resolveSession(sessions, id)).resolves.toBeNull();
    await expect(sessions.get(id)).resolves.toBeNull();
  });

  it('destroys the session when expiry passed and no refresh token exists', async () => {
    const { sessions } = memoryStores();
    const id = await sessions.create({
      subject: 'user-1',
      username: 'demo1',
      accessToken: 'expired-access',
      expiresAt: clockNow - 1_000,
    });

    await expect(resolveSession(sessions, id)).resolves.toBeNull();
    await expect(sessions.get(id)).resolves.toBeNull();
    expect(refreshTokenGrantMock).not.toHaveBeenCalled();
  });

  it('refreshes just before real expiry (clock-skew window)', async () => {
    const { sessions } = memoryStores();
    // expiresAt already subtracts a 30s skew, so being "at" expiry means
    // the raw token is still valid - refresh must still trigger safely.
    const id = await sessions.create({
      subject: 'user-1',
      username: 'demo1',
      accessToken: 'almost-expired',
      refreshToken: 'refresh',
      expiresAt: clockNow,
    });
    refreshTokenGrantMock.mockResolvedValue(tokenResponse() as never);

    await expect(resolveSession(sessions, id)).resolves.toMatchObject({
      accessToken: 'new-access',
    });
  });
});

describe('sanitizeNextPath', () => {
  it('accepts site-relative paths', () => {
    expect(sanitizeNextPath('/feed')).toBe('/feed');
    expect(sanitizeNextPath('/profile/demo2', '/feed')).toBe('/profile/demo2');
  });

  it('rejects absolute URLs and protocol-relative open redirects', () => {
    expect(sanitizeNextPath('https://evil.example')).toBe('/feed');
    expect(sanitizeNextPath('//evil.example')).toBe('/feed');
    expect(sanitizeNextPath(undefined)).toBe('/feed');
    expect(sanitizeNextPath('')).toBe('/feed');
  });
});
