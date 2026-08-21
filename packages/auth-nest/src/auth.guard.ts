import { CanActivate, ExecutionContext, HttpException, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { HEALTH_ROUTES } from '@xitter/config';
import { INTERNAL_CLIENTS, isAdminRole, type TokenVerifier } from '@xitter/auth';
import {
  ADMIN_VERIFIER,
  AUTH_OPTIONS,
  INTERNAL_KEY,
  IS_PUBLIC_KEY,
  SERVICE_VERIFIER,
  USER_VERIFIER,
  type AuthModuleOptions,
  type InternalRouteMetadata,
  type RequestUser,
} from './auth.tokens.js';
import { authorizedParty, bearerToken, edgeIdentity, forbidden, unauthenticated } from './http.js';

type RequestWithUser = { headers: Record<string, unknown>; url?: string; user?: RequestUser };

/**
 * Global request guard, applied once per service. Route kind decides the
 * token model:
 *
 * - default: Bearer **user** token (demo realm, azp = a user client).
 * - `@Internal()`: client-credentials **service** token whose audience is
 *   this service's own client id (workers, reset job, other services). Edge
 *   identity headers are never trusted here.
 * - `@Internal({ admin: true })`: admin principals - either an admin-realm
 *   user token (the panel's PKCE login, azp = the admin-panel client) or a
 *   demo-realm service token (azp per-route/client allowlist). Both paths
 *   require an ADMIN_ROLES realm role; a verified token without one is 403,
 *   not 401, so operators can tell a bad credential from a missing grant.
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
    @Inject(ADMIN_VERIFIER) private readonly adminVerifier: TokenVerifier | null,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const [handler, controller] = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler, controller])) {
      return true;
    }
    const internal = this.reflector.getAllAndOverride<InternalRouteMetadata | undefined>(
      INTERNAL_KEY,
      [handler, controller],
    );
    const isInternal = internal !== undefined;

    const request = context.switchToHttp().getRequest<RequestWithUser>();

    // Infrastructure probes: the shared health routes sit at the service
    // root, outside the versioned prefix, and are never edge-exposed
    // (spec 03) - only the kubelet reaches them in-cluster. They must answer
    // regardless of auth or every restart becomes a crash loop.
    const path = (request.url ?? '').split('?')[0];
    if (HEALTH_ROUTES.some((route) => `/${route}` === path)) {
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
        ? internal === true
          ? await this.verifyServiceRouteToken(token)
          : await this.verifyInternalToken(token, internal)
        : await this.verifyUserToken(token);
      request.user = {
        subject: auth.subject,
        username: auth.username,
        roles: auth.roles,
        service: auth.service,
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
    return this.principal(auth, false);
  }

  /** Legacy `@Internal()` routes: service token against the flat allowlist. */
  private async verifyServiceRouteToken(token: string) {
    const { auth } = await this.verifyServiceToken(token);
    return this.principal(auth, true);
  }

  /** Verifies + azp-checks a demo-realm service token (flat default allowlist). */
  private async verifyServiceToken(token: string): Promise<{
    auth: { subject: string; username: string; roles: string[] };
    azp: string;
  }> {
    const auth = await this.serviceVerifier.verify(token);
    const azp = authorizedParty(auth.claims);
    const allowed = this.options.serviceClients ?? INTERNAL_CLIENTS;
    if (!azp || !allowed.includes(azp)) {
      throw unauthenticated('Service token required');
    }
    return { auth, azp };
  }

  /**
   * Optioned internal routes. `admin` routes admit two principals (ADR 0006
   * realm split: the browser panel lives in the admin realm and cannot hold
   * M2M secrets, so it presents its PKCE user token; machine callers present
   * a demo-realm service token like every other internal route). Both must
   * carry an admin realm role. Non-admin optioned routes are plain service
   * routes with a narrowed azp allowlist (the L5 per-endpoint scoping).
   */
  private async verifyInternalToken(token: string, options: Exclude<InternalRouteMetadata, true>) {
    if (options.admin) {
      return this.verifyAdminToken(token);
    }
    const { auth, azp } = await this.verifyServiceToken(token);
    if (options.clients && !options.clients.includes(azp)) {
      throw unauthenticated('Service token required');
    }
    return this.principal(auth, true);
  }

  private async verifyAdminToken(token: string) {
    // Machine path first: a demo-realm service token (audience = this
    // service) with an admin role on its claims - the `svc-admin` client.
    const serviceToken = await this.serviceVerifier
      .verify(token)
      .then((auth) => ({ auth, azp: authorizedParty(auth.claims) }))
      .catch(() => undefined);
    if (serviceToken) {
      const allowed = this.options.serviceClients ?? INTERNAL_CLIENTS;
      if (!serviceToken.azp || !allowed.includes(serviceToken.azp)) {
        throw unauthenticated('Service token required');
      }
      if (!isAdminRole(serviceToken.auth.roles)) {
        throw forbidden('Admin role required');
      }
      return this.principal(serviceToken.auth, true);
    }

    // Human path: an admin-realm user token (issuer differs, azp = the
    // admin-panel client, no svc-* audience exists for it by design).
    if (!this.options.adminIssuer || !this.adminVerifier) {
      throw unauthenticated('Admin token required');
    }
    const auth = await this.adminVerifier.verify(token);
    const azp = authorizedParty(auth.claims);
    const allowed = this.options.adminClients ?? ['admin-panel'];
    if (!azp || !allowed.includes(azp)) {
      throw unauthenticated('Token not issued to the admin panel client');
    }
    if (!isAdminRole(auth.roles)) {
      throw forbidden('Admin role required');
    }
    return this.principal(auth, false);
  }

  private principal(
    auth: { subject: string; username: string; roles: string[] },
    service: boolean,
  ) {
    return {
      subject: auth.subject,
      username: auth.username,
      roles: auth.roles,
      service,
    };
  }
}
