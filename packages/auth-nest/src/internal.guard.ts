import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { INTERNAL_CLIENTS, type TokenVerifier } from '@xitter/auth';
import { SERVICE_VERIFIER, type AuthModuleOptions, type RequestUser } from './auth.tokens.js';
import { authorizedParty, bearerToken, unauthenticated } from './http.js';

type RequestWithUser = { headers: Record<string, unknown>; user?: RequestUser };

/**
 * Route guard for `internal/*` endpoints: client-credentials service tokens
 * only (workers, reset job, other services). The verifier enforces audience =
 * this service's own client id; the azp check keeps user tokens out even
 * though they pass signature validation. Edge identity headers are never
 * trusted here - internal traffic always carries a real bearer token.
 */
@Injectable()
export class InternalGuard implements CanActivate {
  constructor(
    private readonly options: AuthModuleOptions,
    private readonly serviceVerifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = bearerToken(request.headers);
    if (!token) throw unauthenticated('Service token required');

    const serviceClients = this.options.serviceClients ?? INTERNAL_CLIENTS;
    try {
      const auth = await this.serviceVerifier.verify(token);
      const azp = authorizedParty(auth.claims);
      if (!azp || !serviceClients.includes(azp)) {
        throw unauthenticated('Service token required');
      }
      request.user = {
        subject: auth.subject,
        username: auth.username,
        roles: auth.roles,
        service: true,
      };
      return true;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw unauthenticated('Service token required');
    }
  }
}
