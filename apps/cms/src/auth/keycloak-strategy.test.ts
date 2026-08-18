import { describe, expect, it, vi } from 'vitest';
import type { AuthContext, TokenVerifier } from '@xitter/auth';
import type { Payload } from 'payload';
import { createKeycloakStrategy } from './keycloak-strategy';

function fakeVerifier(auth: Partial<AuthContext>): TokenVerifier {
  return {
    async verify() {
      return {
        subject: 'kc-123',
        username: 'localadmin',
        roles: ['app-admin'],
        audience: undefined,
        claims: {},
        ...auth,
      };
    },
  };
}

/** Minimal payload double: the strategy only uses find/create/update. */
function fakePayload(docs: Array<{ id: number; email?: string; sub?: string; roles?: string[] }>) {
  const payload = {
    find: vi.fn(async () => ({ docs: docs.slice(0, 1) })),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      docs.push({ id: docs.length + 1, ...data } as never);
    }),
    update: vi.fn(async () => ({})),
  };
  return payload as unknown as Payload & typeof payload;
}

const headersWith = (token?: string) =>
  new Headers(token ? { authorization: `Bearer ${token}` } : {});

describe('keycloak auth strategy', () => {
  it('ignores requests without a Bearer token (browser sessions use cookies)', async () => {
    const strategy = createKeycloakStrategy(fakeVerifier({}));
    const result = await strategy.authenticate({
      headers: headersWith(),
      payload: fakePayload([]),
    } as never);
    expect(result).toEqual({ user: null });
  });

  it('rejects valid tokens without the app-admin role', async () => {
    const strategy = createKeycloakStrategy(fakeVerifier({ roles: ['offline_access'] }));
    const result = await strategy.authenticate({
      headers: headersWith('token'),
      payload: fakePayload([]),
    } as never);
    expect(result).toEqual({ user: null });
  });

  it('rejects invalid/expired tokens as unauthenticated (not an error)', async () => {
    const verifier: TokenVerifier = {
      async verify() {
        throw new Error('jwt signature invalid');
      },
    };
    const strategy = createKeycloakStrategy(verifier);
    const result = await strategy.authenticate({
      headers: headersWith('garbage'),
      payload: fakePayload([]),
    } as never);
    expect(result).toEqual({ user: null });
  });

  it('maps an app-admin token onto a users doc keyed by sub', async () => {
    const docs = [{ id: 7, email: 'localadmin@sso.xitter.local', sub: 'kc-123', roles: ['app-admin'] }];
    const payload = fakePayload(docs);
    const strategy = createKeycloakStrategy(fakeVerifier({}));
    const result = (await strategy.authenticate({
      headers: headersWith('token'),
      payload,
    } as never)) as { user: { id: number; collection: string; _strategy: string } };

    expect(result.user.id).toBe(7);
    expect(result.user.collection).toBe('users');
    expect(result.user._strategy).toBe('keycloak');
    expect(payload.find).toHaveBeenCalled();
    expect(payload.create).not.toHaveBeenCalled();
  });

  it('creates the users doc on first login', async () => {
    const docs: Array<{ id: number; sub?: string }> = [];
    const payload = fakePayload(docs);
    // find() returns nothing the first call, the created doc the second.
    let call = 0;
    (payload as never as { find: ReturnType<typeof vi.fn> }).find.mockImplementation(async () => {
      call += 1;
      return call === 1 ? { docs: [] } : { docs: [{ id: 1, sub: 'kc-123' }] };
    });

    const strategy = createKeycloakStrategy(fakeVerifier({}));
    const result = (await strategy.authenticate({
      headers: headersWith('token'),
      payload,
    } as never)) as { user: { id: number } };

    expect(payload.create).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'users',
        data: expect.objectContaining({ sub: 'kc-123', email: 'localadmin@sso.xitter.local' }),
      }),
    );
    expect(result.user.id).toBe(1);
  });
});
