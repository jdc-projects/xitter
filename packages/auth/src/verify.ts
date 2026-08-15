import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AuthContext {
  /** Keycloak user (or service client) id - `sub`. */
  subject: string;
  /** Preferred username (users) or client id (service accounts). */
  username: string;
  /** Realm roles from `realm_access.roles`. */
  roles: string[];
  /** Audience the token was validated against. */
  audience: string;
  /** Raw claims for fine-grained authorisation. */
  claims: Record<string, unknown>;
}

export interface TokenVerifier {
  verify(token: string): Promise<AuthContext>;
}

export interface TokenVerifierOptions {
  /** OIDC issuer, e.g. https://keycloak/realms/xitter-demo */
  issuer: string;
  /** Expected audience; defaults to the verifier's own service client id. */
  audience: string;
  /** JWKS uri; defaults to `<issuer>/protocol/openid-connect/certs`. */
  jwksUri?: string;
}

/** Stateless JWT verifier - local JWKS validation against Keycloak. */
export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  const jwks = createRemoteJWKSet(new URL(options.jwksUri ?? `${options.issuer}/protocol/openid-connect/certs`));
  return {
    async verify(token: string): Promise<AuthContext> {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: options.issuer,
        audience: options.audience,
      });
      const realmAccess = payload.realm_access as { roles?: string[] } | undefined;
      return {
        subject: String(payload.sub ?? ""),
        username: String(payload.preferred_username ?? payload.client_id ?? ""),
        roles: realmAccess?.roles ?? [],
        audience: options.audience,
        claims: payload as Record<string, unknown>,
      };
    },
  };
}

/** Client-credentials token fetcher with in-memory caching (for service-to-service calls). */
export function createJwtCache(options: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}): { get(): Promise<string> } {
  const doFetch = options.fetchImpl ?? fetch;
  let cached: { token: string; expiresAt: number } | undefined;

  return {
    async get(): Promise<string> {
      if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: options.clientId,
        client_secret: options.clientSecret,
      });
      const res = await doFetch(options.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!res.ok) throw new Error(`Token fetch failed (${res.status}) from ${options.tokenUrl}`);
      const json = (await res.json()) as { access_token: string; expires_in: number };
      cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
      return json.access_token;
    },
  };
}
