/**
 * Shared request authentication for Nest services.
 *
 * Model (docs/specs/architecture/07-security.md):
 * - Public routes: Bearer user tokens from the demo realm (web client).
 * - `internal/*` routes: client-credentials service tokens whose audience is
 *   the receiving service's own `svc-*` client id (workers + reset job).
 * - In-cluster (edge mode): identity headers injected by the ingress are
 *   trusted when no bearer token is present; `X-Access-Token` is re-validated.
 * - Rate limiting: Valkey token bucket per user id + IP on mutation routes.
 */
import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';

export const AUTH_OPTIONS = Symbol('AUTH_OPTIONS');
export const USER_VERIFIER = Symbol('USER_VERIFIER');
export const SERVICE_VERIFIER = Symbol('SERVICE_VERIFIER');
export const IS_PUBLIC_KEY = 'xitter:public';
export const INTERNAL_KEY = 'xitter:internal';
export const RATE_LIMIT_KEY = 'xitter:rate-limit';

export interface AuthModuleOptions {
  /** Service name for logging and rate-limit key namespacing. */
  serviceName: string;
  /** Token issuer, e.g. http://localhost:8090/realms/xitter-demo */
  issuer: string;
  /** This service's own `svc-*` client id - the required internal audience. */
  audience: string;
  /**
   * Clients allowed to obtain user-facing tokens (azp allowlist). Defaults to
   * the web app's public client.
   */
  userClients?: string[];
  /**
   * Clients allowed to hold internal (M2M) tokens (azp allowlist): the five
   * services plus the worker and reset-job clients.
   */
  serviceClients?: string[];
  /**
   * Trust edge-injected identity headers (cluster mode). Locally false -
   * services validate Bearer tokens directly.
   */
  trustEdgeHeaders?: boolean;
  /** Valkey URL for rate limiting. */
  redisUrl?: string;
}

export interface RateLimitOptions {
  /** Bucket capacity (burst size). */
  capacity?: number;
  /** Tokens added per second. */
  refillPerSecond?: number;
}

export const DEFAULT_RATE_LIMIT: Required<RateLimitOptions> = {
  capacity: 20,
  refillPerSecond: 1,
};

/** Mark a route as unauthenticated (health checks, docs). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Mark a route as service-token-only (client credentials, audience = this
 * service's client id). The global AuthGuard switches to M2M validation for
 * these routes - user tokens are rejected even when their signature is valid.
 */
export const Internal = () => SetMetadata(INTERNAL_KEY, true);

/** Apply a Valkey token-bucket limit to a mutation route. */
export const RateLimit = (options: RateLimitOptions = {}) => SetMetadata(RATE_LIMIT_KEY, options);

export interface RequestUser {
  subject: string;
  username: string;
  roles: string[];
  /** True for client-credentials (service) principals. */
  service: boolean;
}

type RequestWithUser = { user?: RequestUser };

/** Inject the authenticated principal (AuthGuard must have run). */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestUser | undefined => {
    const request = ctx.switchToHttp().getRequest<RequestWithUser>();
    return request.user;
  },
);
