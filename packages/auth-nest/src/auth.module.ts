import { Global, Module, Provider } from '@nestjs/common';
import { createTokenVerifier, type TokenVerifier } from '@xitter/auth';
import {
  AUTH_OPTIONS,
  SERVICE_VERIFIER,
  USER_VERIFIER,
  type AuthModuleOptions,
} from './auth.tokens.js';
import { AuthGuard } from './auth.guard.js';
import { InternalGuard } from './internal.guard.js';
import { RateLimitGuard } from './rate-limit.guard.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';

/**
 * Wires the shared verifiers and guards for one service. Import once:
 *
 *   AuthModule.forRoot({ serviceName: 'social', issuer, audience: 'svc-social' })
 *
 * `AuthGuard` is registered globally (with `@Public()` as the opt-out);
 * `InternalGuard` and `RateLimitGuard` are applied per-route.
 */
@Global()
@Module({})
export class AuthModule {
  static forRoot(options: AuthModuleOptions) {
    const providers: Provider[] = [
      { provide: AUTH_OPTIONS, useValue: options },
      {
        provide: USER_VERIFIER,
        useValue: createTokenVerifier({ issuer: options.issuer }),
      },
      {
        provide: SERVICE_VERIFIER,
        useValue: createTokenVerifier({ issuer: options.issuer, audience: options.audience }),
      },
      AuthGuard,
      InternalGuard,
      RateLimitGuard,
      TokenBucketRateLimiter,
    ];
    return {
      module: AuthModule,
      global: true,
      providers,
      exports: [AUTH_OPTIONS, USER_VERIFIER, SERVICE_VERIFIER, TokenBucketRateLimiter],
    };
  }
}
