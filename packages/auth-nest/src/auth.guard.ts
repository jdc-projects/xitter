import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { TokenVerifier } from '@xitter/auth';
import {
  IS_PUBLIC_KEY,
  type AuthModuleOptions,
  type RequestUser,
} from './auth.tokens.js';
import { authorizedParty, bearerToken, edgeIdentity, unauthenticated } from './http.js';

type RequestWithUser = { headers: Record<string, unknown>; user?: RequestUser };

/**
 * Global guard for public (user-facing) routes: validates Bearer user tokens
 * against the demo realm and attaches the principal to the request. In
 * cluster mode, edge-injected identity headers are trusted when the request
 * carries no token. `@Public()` opts a route out (health endpoints).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly options: AuthModuleOptions,
    private readonly userVerifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = bearerToken(request.headers);

    if (!token) {
      if (this.options.trustEdgeHeaders) {
        const identity = edgeIdentity(request.headers);
        if (identity) {
          request.user = identity;
          return true;
        }
      }
      throw unauthenticated();
    }

    const userClients = this.options.userClients ?? ['web'];
    try {
      const auth = await this.userVerifier.verify(token);
      const azp = authorizedParty(auth.claims);
      if (!azp || !userClients.includes(azp)) {
        throw unauthenticated('Token not issued to an allowed client');
      }
      request.user = {
        subject: auth.subject,
        username: auth.username,
        roles: auth.roles,
        service: false,
      };
      return true;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw unauthenticated();
    }
  }
}
