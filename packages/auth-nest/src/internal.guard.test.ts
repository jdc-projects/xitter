import { ExecutionContext, HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { TokenVerifier } from '@xitter/auth';
import type { RequestUser } from './auth.tokens.js';
import { InternalGuard } from './internal.guard.js';

const SERVICE_CLIENTS = [
  'svc-social',
  'svc-posts',
  'svc-media',
  'svc-feed',
  'svc-search',
  'svc-worker-fanout',
  'svc-worker-media-process',
  'svc-worker-search-index',
  'svc-reset',
];

const options = {
  serviceName: 'social',
  issuer: 'http://kc/realms/xitter-demo',
  audience: 'svc-social',
  serviceClients: SERVICE_CLIENTS,
};

function createContext(request: {
  headers?: Record<string, string>;
  user?: RequestUser;
}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

const verifier = (claims: Record<string, unknown>, shouldFail = false): TokenVerifier => ({
  async verify() {
    if (shouldFail) throw new Error('audience mismatch');
    return {
      subject: 'service-account-id',
      username: String(claims.azp),
      roles: [],
      audience: 'svc-social',
      claims,
    };
  },
});

describe('InternalGuard', () => {
  it('accepts a service token with the right audience and azp', async () => {
    const guard = new InternalGuard(options, verifier({ azp: 'svc-worker-fanout' }));
    const request: { headers: Record<string, string>; user?: RequestUser } = {
      headers: { authorization: 'Bearer m2m' },
    };
    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.user).toMatchObject({ username: 'svc-worker-fanout', service: true });
  });

  it('accepts the reset-job client', async () => {
    const guard = new InternalGuard(options, verifier({ azp: 'svc-reset' }));
    const request = { headers: { authorization: 'Bearer m2m' } };
    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
  });

  it('rejects missing tokens', async () => {
    const guard = new InternalGuard(options, verifier({ azp: 'svc-reset' }));
    await expect(guard.canActivate(createContext({ headers: {} }))).rejects.toMatchObject({
      status: 401,
    });
  });

  it('rejects audience-mismatched tokens (verifier failure)', async () => {
    const guard = new InternalGuard(options, verifier({ azp: 'svc-posts' }, true));
    const request = { headers: { authorization: 'Bearer wrong-audience' } };
    const err = await guard.canActivate(createContext(request)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(401);
    expect((err as HttpException).getResponse()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Service token required' },
    });
  });

  it('rejects user tokens even when they verify cleanly', async () => {
    const guard = new InternalGuard(options, verifier({ azp: 'web' }));
    const request = { headers: { authorization: 'Bearer user-token' } };
    await expect(guard.canActivate(createContext(request))).rejects.toMatchObject({ status: 401 });
  });

  it('never trusts edge identity headers', async () => {
    const guard = new InternalGuard(
      { ...options, trustEdgeHeaders: true },
      verifier({ azp: 'svc-reset' }),
    );
    const request = { headers: { 'x-user-id': 'spoofed' } };
    await expect(guard.canActivate(createContext(request))).rejects.toMatchObject({ status: 401 });
  });
});
