import { describe, expect, it } from 'vitest';
import { isAdminToken } from './auth-provider.js';
import { accessTokenRoles } from './session.js';

describe('isAdminToken (panel gate over the shared @xitter/auth roles)', () => {
  it('allows admin roles only', () => {
    expect(isAdminToken(['app-admin'])).toBe(true);
    expect(isAdminToken(['system-admin', 'other'])).toBe(true);
    expect(isAdminToken(['demo-user'])).toBe(false);
    expect(isAdminToken([])).toBe(false);
  });
});

describe('accessTokenRoles', () => {
  const jwt = (payload: object) => {
    const encode = (input: object) =>
      btoa(JSON.stringify(input)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${encode({ alg: 'none' })}.${encode(payload)}.sig`;
  };

  it('reads realm roles from the access token payload', () => {
    const token = jwt({ realm_access: { roles: ['system-admin'] } });
    expect(
      accessTokenRoles({ access_token: token } as Parameters<typeof accessTokenRoles>[0]),
    ).toEqual(['system-admin']);
  });

  it('returns [] for a token without roles or a missing session', () => {
    expect(accessTokenRoles({ access_token: jwt({}) } as never)).toEqual([]);
    expect(accessTokenRoles(null)).toEqual([]);
  });

  it('never throws on a malformed token (UI gating must not crash the panel)', () => {
    expect(accessTokenRoles({ access_token: 'not-a-jwt' } as never)).toEqual([]);
  });
});
