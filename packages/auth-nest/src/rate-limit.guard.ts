import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createLogger } from '@xitter/observability';
import {
  DEFAULT_RATE_LIMIT,
  RATE_LIMIT_KEY,
  type RateLimitOptions,
  type RequestUser,
} from './auth.tokens.js';
import { errorBody } from './http.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';

type RequestWithUser = { ip?: string; routePath?: string; user?: RequestUser };

const logger = createLogger({ service: 'auth-nest' });

/**
 * Valkey token bucket per user id + IP for mutation routes. Applied with
 * `@UseGuards(RateLimitGuard)` + `@RateLimit({...})`; feature tickets add it
 * to their mutation endpoints. Fails open when Valkey is unavailable -
 * availability beats throttling in this demo.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: TokenBucketRateLimiter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? {};
    const capacity = options.capacity ?? DEFAULT_RATE_LIMIT.capacity;
    const refillPerSecond = options.refillPerSecond ?? DEFAULT_RATE_LIMIT.refillPerSecond;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const response = context.switchToHttp().getResponse<{ header: (name: string, value: string | number) => void }>();

    const handler = context.getHandler();
    const route = handler.name || 'route';
    const userId = request.user?.subject ?? 'anonymous';
    const ip = request.ip ?? 'unknown';

    try {
      const result = await this.limiter.consume({ userId, ip, route }, capacity, refillPerSecond);
      if (!result.allowed) {
        response.header('retry-after', result.retryAfterSeconds ?? 1);
        throw new HttpException(
          errorBody('RATE_LIMITED', 'Too many requests - slow down and retry later'),
          429,
        );
      }
      return true;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      // Valkey unavailable (or slow): fail open rather than blocking traffic.
      logger.error({ err: String(err) }, 'rate limiter unavailable - failing open');
      return true;
    }
  }
}
