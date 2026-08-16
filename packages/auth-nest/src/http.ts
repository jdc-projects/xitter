import { HttpException } from '@nestjs/common';
import type { RequestUser } from './auth.tokens.js';

type Headers = Record<string, unknown>;

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/** Error envelope from docs/specs/architecture/03-service-interfaces.md. */
export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export function unauthenticated(message = 'Authentication required'): HttpException {
  return new HttpException(errorBody('UNAUTHENTICATED', message), 401);
}

export function forbidden(message = 'Forbidden'): HttpException {
  return new HttpException(errorBody('FORBIDDEN', message), 403);
}

/**
 * Bearer token from `Authorization`, falling back to the edge-forwarded
 * `X-Access-Token` (always re-validated, never trusted blindly).
 */
export function bearerToken(headers: Headers): string | undefined {
  const authorization = header(headers, 'authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    const token = authorization.slice(7).trim();
    if (token) return token;
  }
  return header(headers, 'x-access-token');
}

/**
 * Edge-injected identity (cluster mode): the ingress validates the JWT and
 * injects these headers; services trust them only for in-cluster requests
 * that carry no bearer token at all.
 */
export function edgeIdentity(headers: Headers): RequestUser | undefined {
  const subject = header(headers, 'x-user-id');
  if (!subject) return undefined;
  return {
    subject,
    username: header(headers, 'x-user-name') ?? subject,
    roles: (header(headers, 'x-user-roles') ?? '')
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean),
    service: false,
  };
}

/** Authorized party: the client the token was issued to. */
export function authorizedParty(claims: Record<string, unknown>): string | undefined {
  const azp = claims.azp ?? claims.client_id;
  return typeof azp === 'string' && azp.length > 0 ? azp : undefined;
}
