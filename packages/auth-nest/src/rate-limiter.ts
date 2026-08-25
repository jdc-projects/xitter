import { Inject, Injectable } from '@nestjs/common';
import { AUTH_OPTIONS, type AuthModuleOptions } from './auth.tokens.js';

/**
 * Structural slice of ioredis used by the token bucket - keeps the limiter
 * unit-testable without a live Valkey.
 */
export interface RedisEval {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface RedisConnectionLike {
  eval: RedisEval['eval'];
  quit(): Promise<unknown>;
}

export interface ConsumeResult {
  allowed: boolean;
  /** Seconds until at least one token is available (denied requests only). */
  retryAfterSeconds?: number;
}

/**
 * Atomic token bucket: a negative reply denies the request and carries the
 * retry delay as its magnitude. State expires so idle buckets disappear
 * (everything resets nightly anyway).
 */
const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])
local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  ts = now
end
local elapsed = math.max(0, now - ts) / 1000
tokens = math.min(capacity, tokens + elapsed * refill)
local allowed = tokens >= requested
if allowed then
  tokens = tokens - requested
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', KEYS[1], math.ceil(capacity / refill * 2))
if allowed then
  return 1
end
return -math.ceil((requested - tokens) / refill)
`;

@Injectable()
export class TokenBucketRateLimiter {
  private connection?: RedisConnectionLike;

  // Interfaces vanish at runtime - inject via token, not type.
  constructor(@Inject(AUTH_OPTIONS) private readonly options: AuthModuleOptions) {}

  /** Test seam: inject a fake/scripted connection. */
  useConnection(connection: RedisConnectionLike): void {
    this.connection = connection;
  }

  async consume(
    parts: { userId: string; ip: string; route: string },
    capacity: number,
    refillPerSecond: number,
  ): Promise<ConsumeResult> {
    const connection = await this.connect();
    const key = `ratelimit:${this.options.serviceName}:${parts.route}:${parts.userId}:${parts.ip}`;
    let reply: unknown;
    try {
      reply = await connection.eval(
        TOKEN_BUCKET_LUA,
        1,
        key,
        capacity,
        refillPerSecond,
        Date.now(),
        1,
      );
    } catch (err) {
      // The cached connection can die underneath us (Valkey restart, or the
      // nightly reset's FLUSHALL severing streams - ioredis with
      // enableOfflineQueue:false then throws on EVERY command forever, and
      // rate limiting would stay failed-open until a pod restart). Discard
      // the dead handle so the next consume reconnects, then rethrow: this
      // request fails open as designed.
      this.discardConnection();
      throw err;
    }
    const value = Number(reply);
    if (value === 1) return { allowed: true };
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.abs(value)) };
  }

  private async connect(): Promise<RedisConnectionLike> {
    if (this.connection) return this.connection;
    const { Redis } = await import('ioredis');
    const connection = new Redis(this.options.redisUrl ?? 'redis://localhost:6379', {
      // Fail fast while Valkey is unavailable: rate limiting fails open and
      // must never block requests on connection retries.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2_000,
    }) as unknown as RedisConnectionLike;
    this.connection = connection;
    return connection;
  }

  /** Drop the cached handle (dead stream) so the next consume reconnects. */
  private discardConnection(): void {
    const dead = this.connection;
    this.connection = undefined;
    dead?.quit().catch(() => undefined);
  }

  // Nest invokes this via OnApplicationShutdown at shutdown - no direct
  // references by design.
  // fallow-ignore-next-line unused-class-member
  async onApplicationShutdown(): Promise<void> {
    await this.connection?.quit().catch(() => undefined);
  }
}
