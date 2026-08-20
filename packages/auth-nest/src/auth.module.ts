import { Global, Module, Provider } from '@nestjs/common';
import { createLogger } from '@xitter/observability';
import { createTokenVerifier } from '@xitter/auth';
import {
  ADMIN_VERIFIER,
  AUTH_OPTIONS,
  SERVICE_VERIFIER,
  USER_VERIFIER,
  type AuthModuleOptions,
} from './auth.tokens.js';
import { AuthGuard } from './auth.guard.js';
import { RateLimitGuard } from './rate-limit.guard.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';

const logger = createLogger({ service: 'auth-nest' });

/**
 * Wires the shared verifiers and guards for one service. Import once:
 *
 *   AuthModule.forRoot({ serviceName: 'social', issuer, audience: 'svc-social' })
 *
 * `AuthGuard` is registered globally (with `@Public()`/`@Internal()` as the
 * mode switches); `RateLimitGuard` is applied per-route.
 */
@Global()
@Module({})
export class AuthModule {
  static forRoot(options: AuthModuleOptions) {
    if (options.trustEdgeHeaders) {
      logger.warn(
        `${options.serviceName}: AUTH edge-header trust is ENABLED - identity headers are accepted without validation. ` +
          'This is a full auth bypass unless the validating ingress is the only network path to this service ' +
          '(local Traefik does not strip these headers - keep it off locally).',
      );
    }
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
      // Null when no admin realm is configured: admin routes then fail closed.
      {
        provide: ADMIN_VERIFIER,
        useValue: options.adminIssuer ? createTokenVerifier({ issuer: options.adminIssuer }) : null,
      },
      AuthGuard,
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
