import { type ExecutionContext, HttpException } from '@nestjs/common';
import { type Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import type { TokenVerifier } from '@xitter/auth';
import { AuthGuard } from './auth.guard.js';
import {
  INTERNAL_KEY,
  IS_PUBLIC_KEY,
  type AuthModuleOptions,
  type InternalRouteMetadata,
  type RequestUser,
} from './auth.tokens.js';

type RouteKind = 'public' | 'internal' | 'user' | 'admin-internal' | 'scoped-internal';

function createContext(
  request: {
    headers?: Record<string, string | string[]>;
    url?: string;
    user?: RequestUser;
  },
  kind: RouteKind = 'user',
): ExecutionContext {
  const internalMeta: InternalRouteMetadata | undefined =
    kind === 'internal'
      ? true
      : kind === 'admin-internal'
        ? { admin: true }
        : kind === 'scoped-internal'
          ? { clients: ['svc-worker-media-process'] }
          : undefined;
  const handler: Record<string, unknown> = {
    ...(kind === 'public' ? { [IS_PUBLIC_KEY]: true } : {}),
    ...(internalMeta !== undefined ? { [INTERNAL_KEY]: internalMeta } : {}),
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
    getHandler: () => handler,
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function reflector(): Reflector {
  return {
    getAllAndOverride: (_key: string, [handler]: [Record<string, unknown>]) => handler?.[_key],
  } as unknown as Reflector;
}

function verifier(
  claims: Record<string, unknown>,
  shouldFail = false,
  overrides: { subject?: string; username?: string; roles?: string[] } = {},
): TokenVerifier {
  return {
    async verify() {
      if (shouldFail) throw new Error('invalid token');
      return {
        subject: 'principal-1',
        username: String(claims.azp ?? 'demo1'),
        roles: ['demo-user'],
        audience: 'svc-social',
        claims,
        ...overrides,
      };
    },
  };
}

const options: AuthModuleOptions = {
  serviceName: 'social',
  issuer: 'http://kc/realms/xitter-demo',
  audience: 'svc-social',
};

const adminOptions: AuthModuleOptions = {
  ...options,
  adminIssuer: 'http://kc/realms/xitter-local-admin',
};

function makeGuard(
  userClaims: Record<string, unknown>,
  serviceClaims: Record<string, unknown>,
  userFails = false,
  serviceFails = false,
  guardOptions = options,
  adminVerifier?: TokenVerifier | null,
): AuthGuard {
  return new AuthGuard(
    reflector(),
    guardOptions,
    verifier(userClaims, userFails),
    verifier(serviceClaims, serviceFails),
    adminVerifier === undefined
      ? verifier({}, false, { subject: 'admin-1', roles: ['system-admin'] })
      : adminVerifier,
  );
}

describe('AuthGuard (user routes)', () => {
  it('accepts a valid user token issued to the web client', async () => {
    const guard = makeGuard({ azp: 'web' }, { azp: 'svc-reset' });
    const request: { headers: Record<string, string>; user?: RequestUser } = {
      headers: { authorization: 'Bearer good-token' },
    };
    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.user).toMatchObject({ subject: 'principal-1', service: false });
  });

  it('rejects requests without a token (local mode)', async () => {
    const guard = makeGuard({ azp: 'web' }, { azp: 'svc-reset' });
    const err = await guard.canActivate(createContext({ headers: {} })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(401);
    expect((err as HttpException).getResponse()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    });
  });

  it('rejects a token whose verifier fails (bad signature, expired...)', async () => {
    const guard = makeGuard({}, {}, true, false);
    const err = await guard
      .canActivate(createContext({ headers: { authorization: 'Bearer tampered' } }))
      .catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(401);
  });

  it('rejects service tokens on user routes (azp not a user client)', async () => {
    const guard = makeGuard({ azp: 'svc-reset' }, { azp: 'svc-reset' });
    const err = await guard
      .canActivate(createContext({ headers: { authorization: 'Bearer m2m' } }))
      .catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(401);
  });

  it('accepts the edge-forwarded token via X-Access-Token', async () => {
    const guard = makeGuard({ azp: 'web' }, { azp: 'svc-reset' });
    await expect(
      guard.canActivate(createContext({ headers: { 'x-access-token': 'forwarded' } })),
    ).resolves.toBe(true);
  });

  it('rejects an invalid X-Access-Token - forwarded tokens are re-validated', async () => {
    const guard = makeGuard({}, {}, true, false);
    const err = await guard
      .canActivate(createContext({ headers: { 'x-access-token': 'forged-or-expired' } }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(401);
  });

  it('trusts edge identity headers in cluster mode when no token is present', async () => {
    const guard = makeGuard({}, {}, true, false, { ...options, trustEdgeHeaders: true });
    const request: { headers: Record<string, string>; user?: RequestUser } = {
      headers: { 'x-user-id': 'user-9', 'x-user-name': 'demo9', 'x-user-roles': 'demo-user' },
    };
    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.user).toMatchObject({ subject: 'user-9', username: 'demo9' });
  });

  it('does not trust edge identity headers in local mode', async () => {
    const guard = makeGuard({}, {}, true, false);
    const err = await guard
      .canActivate(createContext({ headers: { 'x-user-id': 'attacker' } }))
      .catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(401);
  });

  it('lets @Public routes through without a token', async () => {
    const guard = makeGuard({}, {}, true, true);
    await expect(guard.canActivate(createContext({ headers: {} }, 'public'))).resolves.toBe(true);
  });

  it.each(['/healthz', '/readyz'])('lets kubelet probe %s through without a token', async (url) => {
    const guard = makeGuard({}, {}, true, true);
    await expect(guard.canActivate(createContext({ headers: {}, url }))).resolves.toBe(true);
  });

  it('still guards a non-probe root path (only exact probe URLs are exempt)', async () => {
    const guard = makeGuard({}, {}, true, true);
    const err = await guard
      .canActivate(createContext({ headers: {}, url: '/healthz-other' }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
  });
});

describe('AuthGuard (@Internal routes)', () => {
  it('accepts a service token with the right audience and azp', async () => {
    const guard = makeGuard({ azp: 'web' }, { azp: 'svc-worker-fanout' });
    const request: { headers: Record<string, string>; user?: RequestUser } = {
      headers: { authorization: 'Bearer m2m' },
    };
    await expect(guard.canActivate(createContext(request, 'internal'))).resolves.toBe(true);
    expect(request.user).toMatchObject({ username: 'svc-worker-fanout', service: true });
  });

  it('accepts the reset-job client', async () => {
    const guard = makeGuard({ azp: 'web' }, { azp: 'svc-reset' });
    await expect(
      guard.canActivate(createContext({ headers: { authorization: 'Bearer m2m' } }, 'internal')),
    ).resolves.toBe(true);
  });

  it('rejects missing tokens with the service-token message', async () => {
    const guard = makeGuard({ azp: 'web' }, { azp: 'svc-reset' });
    const err = await guard
      .canActivate(createContext({ headers: {} }, 'internal'))
      .catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(401);
    expect((err as HttpException).getResponse()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Service token required' },
    });
  });

  it('rejects audience-mismatched tokens (verifier failure)', async () => {
    const guard = makeGuard({ azp: 'web' }, { azp: 'svc-posts' }, false, true);
    const err = await guard
      .canActivate(createContext({ headers: { authorization: 'Bearer wrong-aud' } }, 'internal'))
      .catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(401);
  });

  it('rejects user tokens even when they verify cleanly', async () => {
    const guard = makeGuard({ azp: 'web' }, { azp: 'web' });
    const err = await guard
      .canActivate(createContext({ headers: { authorization: 'Bearer user' } }, 'internal'))
      .catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(401);
  });

  it('never trusts edge identity headers on internal routes', async () => {
    const guard = makeGuard({ azp: 'web' }, { azp: 'svc-reset' }, false, false, {
      ...options,
      trustEdgeHeaders: true,
    });
    const err = await guard
      .canActivate(createContext({ headers: { 'x-user-id': 'spoofed' } }, 'internal'))
      .catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(401);
  });
});

describe('AuthGuard (@Internal({ admin: true }) routes)', () => {
  it('accepts an admin-realm user token issued to the panel client', async () => {
    const direct = new AuthGuard(
      reflector(),
      adminOptions,
      verifier({ azp: 'web' }, true),
      verifier({ azp: 'svc-admin' }, true), // not a demo-realm-verifiable token here
      verifier({ azp: 'admin-panel' }, false, {
        subject: 'localadmin-uuid',
        username: 'localadmin',
        roles: ['app-admin'],
      }),
    );
    const request: { headers: Record<string, string>; user?: RequestUser } = {
      headers: { authorization: 'Bearer admin-user-token' },
    };
    await expect(direct.canActivate(createContext(request, 'admin-internal'))).resolves.toBe(true);
    expect(request.user).toMatchObject({ username: 'localadmin', service: false });
  });

  it('accepts a demo-realm svc-admin service token carrying the admin role', async () => {
    const direct = new AuthGuard(
      reflector(),
      adminOptions,
      verifier({ azp: 'web' }, true),
      verifier({ azp: 'svc-admin' }, false, { roles: ['system-admin'] }),
      null,
    );
    const request: { headers: Record<string, string>; user?: RequestUser } = {
      headers: { authorization: 'Bearer machine-token' },
    };
    await expect(direct.canActivate(createContext(request, 'admin-internal'))).resolves.toBe(true);
    expect(request.user).toMatchObject({ username: 'svc-admin', service: true });
  });

  it('rejects a role-less service token with 403 (missing grant, not bad credential)', async () => {
    const direct = new AuthGuard(
      reflector(),
      adminOptions,
      verifier({ azp: 'web' }, true),
      verifier({ azp: 'svc-worker-fanout' }, false, { roles: [] }),
      null,
    );
    const err = await direct
      .canActivate(
        createContext({ headers: { authorization: 'Bearer no-role' } }, 'admin-internal'),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(403);
  });

  it('rejects a role-less admin-realm user token with 403', async () => {
    const direct = new AuthGuard(
      reflector(),
      adminOptions,
      verifier({ azp: 'web' }, true),
      verifier({ azp: 'svc-admin' }, true),
      verifier({ azp: 'admin-panel' }, false, { roles: [] }),
    );
    const err = await direct
      .canActivate(
        createContext({ headers: { authorization: 'Bearer localuser-token' } }, 'admin-internal'),
      )
      .catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(403);
  });

  it('rejects admin-realm tokens from a non-panel client', async () => {
    const direct = new AuthGuard(
      reflector(),
      adminOptions,
      verifier({ azp: 'web' }, true),
      verifier({ azp: 'svc-admin' }, true),
      verifier({ azp: 'some-other-client' }, false, { roles: ['system-admin'] }),
    );
    const err = await direct
      .canActivate(
        createContext({ headers: { authorization: 'Bearer stranger' } }, 'admin-internal'),
      )
      .catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(401);
  });

  it('rejects demo-realm user tokens (azp = web) on admin routes', async () => {
    const direct = new AuthGuard(
      reflector(),
      adminOptions,
      verifier({ azp: 'web' }, true),
      verifier({ azp: 'web' }, true),
      verifier({ azp: 'web' }, false, { roles: ['system-admin'] }),
    );
    const err = await direct
      .canActivate(
        createContext({ headers: { authorization: 'Bearer demo-user' } }, 'admin-internal'),
      )
      .catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(401);
  });

  it('fails closed when no admin realm is configured', async () => {
    const direct = new AuthGuard(
      reflector(),
      options, // no adminIssuer
      verifier({ azp: 'web' }, true),
      verifier({ azp: 'svc-admin' }, true),
      verifier({ azp: 'admin-panel' }, false, { roles: ['system-admin'] }),
    );
    const err = await direct
      .canActivate(
        createContext({ headers: { authorization: 'Bearer admin-token' } }, 'admin-internal'),
      )
      .catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(401);
  });
});

describe('AuthGuard (@Internal({ clients: [...] }) routes)', () => {
  it('accepts a service token whose azp is in the per-route allowlist', async () => {
    const guard = makeGuard({ azp: 'web' }, { azp: 'svc-worker-media-process' });
    await expect(
      guard.canActivate(
        createContext({ headers: { authorization: 'Bearer m2m' } }, 'scoped-internal'),
      ),
    ).resolves.toBe(true);
  });

  it('rejects an otherwise-valid internal client outside the per-route allowlist', async () => {
    const guard = makeGuard({ azp: 'web' }, { azp: 'svc-reset' });
    const err = await guard
      .canActivate(
        createContext({ headers: { authorization: 'Bearer m2m' } }, 'scoped-internal'),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(401);
    expect((err as HttpException).getResponse()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Service token required' },
    });
  });
});
