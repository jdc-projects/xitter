import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { type RateLimitOptions, type RequestUser } from './auth.tokens.js';
import { RateLimitGuard } from './rate-limit.guard.js';
import { TokenBucketRateLimiter, type RedisConnectionLike } from './rate-limiter.js';

function createContext(request: {
  ip?: string;
  user?: RequestUser;
  options?: RateLimitOptions;
  headers?: Record<string, unknown>;
}): { context: ExecutionContext; response: { headers: Record<string, unknown> } } {
  const response = {
    headers: {} as Record<string, unknown>,
    header(name: string, value: string | number) {
      this.headers[name] = value;
    },
  };
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
  return { context, response };
}

function reflectorReturning(options?: RateLimitOptions): Reflector {
  return {
    getAllAndOverride: () => options,
  } as unknown as Reflector;
}

const user: RequestUser = { subject: 'user-1', username: 'demo1', roles: [], service: false };

describe('RateLimitGuard', () => {
  it('allows while the bucket has tokens and keys by user + ip', async () => {
    const calls: { script: string; args: (string | number)[] }[] = [];
    const limiter = new TokenBucketRateLimiter({ serviceName: 'social', issuer: '', audience: '' });
    limiter.useConnection(fakeRedis(calls, () => 1));
    const guard = new RateLimitGuard(reflectorReturning({}), limiter);

    const { context } = createContext({ ip: '127.0.0.1', user });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(calls[0]!.args[0]).toBe('ratelimit:social:route:user-1:127.0.0.1');
  });

  it('returns 429 RATE_LIMITED with Retry-After when denied', async () => {
    const limiter = new TokenBucketRateLimiter({ serviceName: 'social', issuer: '', audience: '' });
    limiter.useConnection(fakeRedis([], () => -7));
    const guard = new RateLimitGuard(reflectorReturning({}), limiter);

    const { context, response } = createContext({ ip: '127.0.0.1', user });
    const err = await guard.canActivate(context).catch((e: unknown) => e);
    expect((err as { getStatus(): number }).getStatus()).toBe(429);
    expect((err as { getResponse(): unknown }).getResponse()).toEqual({
      error: { code: 'RATE_LIMITED', message: expect.stringContaining('Too many requests') },
    });
    expect(response.headers['retry-after']).toBe(7);
  });

  it('fails open when Valkey is unavailable', async () => {
    const limiter = new TokenBucketRateLimiter({ serviceName: 'social', issuer: '', audience: '' });
    limiter.useConnection(fakeRedis([], () => Promise.reject(new Error('connection refused'))));
    const guard = new RateLimitGuard(reflectorReturning({}), limiter);

    const { context } = createContext({ ip: '127.0.0.1', user });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('passes capacity and refill from the @RateLimit metadata', async () => {
    const calls: { script: string; args: (string | number)[] }[] = [];
    const limiter = new TokenBucketRateLimiter({ serviceName: 'social', issuer: '', audience: '' });
    limiter.useConnection(fakeRedis(calls, () => 1));
    const guard = new RateLimitGuard(reflectorReturning({ capacity: 5, refillPerSecond: 2 }), limiter);

    const { context } = createContext({ ip: '10.0.0.1', user });
    await guard.canActivate(context);
    expect(calls[0]!.args[1]).toBe(5);
    expect(calls[0]!.args[2]).toBe(2);
  });

  it('uses default capacity/refill without metadata', async () => {
    const calls: { script: string; args: (string | number)[] }[] = [];
    const limiter = new TokenBucketRateLimiter({ serviceName: 'social', issuer: '', audience: '' });
    limiter.useConnection(fakeRedis(calls, () => 1));
    const guard = new RateLimitGuard(reflectorReturning(undefined), limiter);

    const { context } = createContext({ ip: '10.0.0.2', user });
    await guard.canActivate(context);
    expect(calls[0]!.args[1]).toBe(20);
    expect(calls[0]!.args[2]).toBe(1);
  });
});

function fakeRedis(
  calls: { script: string; args: (string | number)[] }[],
  reply: () => number | Promise<number>,
): RedisConnectionLike {
  return {
    async eval(script: string, _numKeys: number, ...args: (string | number)[]) {
      calls.push({ script, args });
      return reply();
    },
    async quit() {
      return 'OK';
    },
  };
}
