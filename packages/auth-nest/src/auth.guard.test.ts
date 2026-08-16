import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import type { TokenVerifier } from '@xitter/auth';
import { AuthGuard } from './auth.guard.js';
import { IS_PUBLIC_KEY } from './auth.tokens.js';
import type { RequestUser } from './auth.tokens.js';

function createContext(request: {
  headers?: Record<string, string | string[]>;
  user?: RequestUser;
  isPublic?: boolean;
}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
    getHandler: () => (request.isPublic ? { [IS_PUBLIC_KEY]: true } : {}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function fakeReflector(): Reflector {
  return {
    getAllAndOverride: (_key: string, targets: unknown[]) =>
      targets.some((target) => target && typeof target === 'object' && IS_PUBLIC_KEY in target),
  } as unknown as Reflector;
}

const userVerifier = (claims: Record<string, unknown>, shouldFail = false): TokenVerifier => ({
  async verify() {
    if (shouldFail) throw new Error('invalid token');
    return {
      subject: 'user-1',
      username: 'demo1',
      roles: ['demo-user'],
      audience: undefined,
      claims,
    };
  },
});

const baseOptions = { serviceName: 'social', issuer: 'http://kc/realms/xitter-demo', audience: 'svc-social' };

describe('AuthGuard', () => {
  it('accepts a valid user token issued to the web client', async () => {
    const guard = new AuthGuard(fakeReflector(), baseOptions, userVerifier({ azp: 'web' }));
    const request: { headers: Record<string, string>; user?: RequestUser } = {
      headers: { authorization: 'Bearer good-token' },
    };
    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.user).toMatchObject({ subject: 'user-1', username: 'demo1', service: false });
  });

  it('rejects requests without a token (local mode)', async () => {
    const guard = new AuthGuard(fakeReflector(), baseOptions, userVerifier({ azp: 'web' }));
    const request = { headers: {} };
    await expect(guard.canActivate(createContext(request))).rejects.toMatchObject({
      status: 401,
      response: { error: { code: 'UNAUTHENTICATED' } },
    });
  });

  it('rejects a token whose verifier fails (bad signature, expired...)', async () => {
    const guard = new AuthGuard(fakeReflector(), baseOptions, userVerifier({}, true));
    const request = { headers: { authorization: 'Bearer tampered' } };
    const err = await guard.canActivate(createContext(request)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(401);
    expect((err as HttpException).getResponse()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    });
  });

  it('rejects service tokens on user routes (azp not a user client)', async () => {
    const guard = new AuthGuard(fakeReflector(), baseOptions, userVerifier({ azp: 'svc-reset' }));
    const request = { headers: { authorization: 'Bearer m2m' } };
    await expect(guard.canActivate(createContext(request))).rejects.toMatchObject({ status: 401 });
  });

  it('accepts the edge-forwarded token via X-Access-Token', async () => {
    const guard = new AuthGuard(fakeReflector(), baseOptions, userVerifier({ azp: 'web' }));
    const request: { headers: Record<string, string>; user?: RequestUser } = {
      headers: { 'x-access-token': 'forwarded' },
    };
    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
  });

  it('trusts edge identity headers in cluster mode when no token is present', async () => {
    const guard = new AuthGuard(
      fakeReflector(),
      { ...baseOptions, trustEdgeHeaders: true },
      userVerifier({}, true),
    );
    const request: { headers: Record<string, string>; user?: RequestUser } = {
      headers: { 'x-user-id': 'user-9', 'x-user-name': 'demo9', 'x-user-roles': 'demo-user' },
    };
    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(request.user).toMatchObject({ subject: 'user-9', username: 'demo9', service: false });
  });

  it('does not trust edge identity headers in local mode', async () => {
    const guard = new AuthGuard(fakeReflector(), baseOptions, userVerifier({}, true));
    const request = { headers: { 'x-user-id': 'attacker' } };
    await expect(guard.canActivate(createContext(request))).rejects.toMatchObject({ status: 401 });
  });

  it('lets @Public routes through without a token', async () => {
    const guard = new AuthGuard(fakeReflector(), baseOptions, userVerifier({}, true));
    await expect(guard.canActivate(createContext({ headers: {}, isPublic: true }))).resolves.toBe(
      true,
    );
  });
});
