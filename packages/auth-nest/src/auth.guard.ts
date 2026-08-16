import { CanActivate, ExecutionContext, HttpException, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { INTERNAL_CLIENTS, type TokenVerifier } from '@xitter/auth';
import {
  AUTH_OPTIONS,
  INTERNAL_KEY,
  IS_PUBLIC_KEY,
  SERVICE_VERIFIER,
  USER_VERIFIER,
  type AuthModuleOptions,
  type RequestUser,
} from './auth.tokens.js';
import { authorizedParty, bearerToken, edgeIdentity, unauthenticated } from './http.js';

type RequestWithUser = { headers: Record<string, unknown>; url?: string; user?: RequestUser };

/**
 * Global request guard, applied once per service. Route kind decides the
 * token model:
 *
 * - default: Bearer **user** token (demo realm, azp = a user client).
 * - `@Internal()`: client-credentials **service** token whose audience is
 *   this service's own client id (workers, reset job, other services). Edge
 *   identity headers are never trusted here.
 * - `@Public()`: no auth (health checks).
 *
 * In cluster mode (`trustEdgeHeaders`), edge-injected identity headers are
 * trusted for requests carrying no bearer token at all; `X-Access-Token` is
 * always re-validated. Keeping both modes in one guard removes the
 * route-guard ordering trap a separate internal guard would create.
 * Precondition: the validating ingress must be the only network path to the
 * service - anything that reaches it directly (local Traefik does not strip
 * these headers) bypasses authentication entirely.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    // Interfaces vanish at runtime - inject via token, not type.
    @Inject(AUTH_OPTIONS) private readonly options: AuthModuleOptions,
    @Inject(USER_VERIFIER) private readonly userVerifier: TokenVerifier,
    @Inject(SERVICE_VERIFIER) private readonly serviceVerifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const [handler, controller] = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, controller])) {
      return true;
    }
    const isInternal = this.reflector.getAllAndOverride<boolean>(INTERNAL_KEY, [
      handler,
      controller,
    ]);

    const request = context.switchToHttp().getRequest<RequestWithUser>();

    // Infrastructure probes: /healthz + /readyz sit at the service root,
    // outside the versioned prefix, and are never edge-exposed (spec 03) -
    // only the kubelet reaches them in-cluster. They must answer regardless
    // of auth or every restart becomes a crash loop.
    const path = (request.url ?? '').split('?')[0];
    if (path === '/healthz' || path === '/readyz') {
      return true;
    }

    const token = bearerToken(request.headers);

    if (!token) {
      if (!isInternal && this.options.trustEdgeHeaders) {
        const identity = edgeIdentity(request.headers);
        if (identity) {
          request.user = identity;
          return true;
        }
      }
      throw unauthenticated(isInternal ? 'Service token required' : undefined);
    }

    try {
      const auth = isInternal
        ? await this.verifyServiceToken(token)
        : await this.verifyUserToken(token);
      request.user = {
        subject: auth.subject,
        username: auth.username,
        roles: auth.roles,
        service: isInternal === true,
      };
      return true;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw unauthenticated(isInternal ? 'Service token required' : undefined);
    }
  }

  private async verifyUserToken(token: string) {
    const auth = await this.userVerifier.verify(token);
    const azp = authorizedParty(auth.claims);
    const allowed = this.options.userClients ?? ['web'];
    if (!azp || !allowed.includes(azp)) {
      throw unauthenticated('Token not issued to an allowed client');
    }
    return auth;
  }

  private async verifyServiceToken(token: string) {
    const auth = await this.serviceVerifier.verify(token);
    const azp = authorizedParty(auth.claims);
    const allowed = this.options.serviceClients ?? INTERNAL_CLIENTS;
    if (!azp || !allowed.includes(azp)) {
      throw unauthenticated('Service token required');
    }
    return auth;
  }
}
