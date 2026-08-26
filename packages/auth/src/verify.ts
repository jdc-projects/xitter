export interface AuthContext {
  /** Keycloak user (or service client) id - `sub`. */
  subject: string;
  /** Preferred username (users) or client id (service accounts). */
  username: string;
  /** Realm roles from `realm_access.roles`. */
  roles: string[];
  /** Audiences the token carries (`aud` claim, comma-joined when multiple). */
  audience: string | undefined;
  /** Raw claims for fine-grained authorisation. */
  claims: Record<string, unknown>;
}

export interface TokenVerifier {
  verify(token: string): Promise<AuthContext>;
}

export interface TokenVerifierOptions {
  /** OIDC issuer, e.g. https://keycloak/realms/xitter-demo */
  issuer: string;
  /**
   * Expected audience. Service (M2M) tokens must carry it; user tokens are
   * validated by issuer + authorized party instead, so they use verifiers
   * without an audience constraint (callers enforce `azp` themselves).
   */
  audience?: string;
  /** JWKS uri; defaults to `<issuer>/protocol/openid-connect/certs`. */
  jwksUri?: string;
}

// jose is ESM-only and its types don't re-export cleanly to CJS, so it is
// loaded dynamically behind a minimal structural type.
interface JoseModule {
  createRemoteJWKSet(url: URL): unknown;
  jwtVerify(
    token: string,
    key: unknown,
    options: Record<string, unknown>,
  ): Promise<{ payload: Record<string, unknown>; protectedHeader: Record<string, unknown> }>;
}

let josePromise: Promise<JoseModule> | undefined;
function jose(): Promise<JoseModule> {
  josePromise ??= import('jose') as Promise<JoseModule>;
  return josePromise;
}

/** Stateless JWT verifier - local JWKS validation against Keycloak. */
export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  let jwks: unknown;

  // Keycloak derives `iss` from the scheme of the URL that minted the token
  // (KC_PROXY_HEADERS=xforwarded): a grant via the public https edge carries
  // https://..., the same grant via the in-cluster http service carries
  // http://... A single configured issuer can only match one population.
  // Accept the configured issuer in EITHER scheme - the JWKS fetch
  // (jwksUri, in-cluster transport) validates the realm's single key set
  // either way, and azp/audience checks constrain the client separately.
  const issuerVariants = options.issuer.startsWith('https://')
    ? [options.issuer, options.issuer.replace(/^https:/, 'http:')]
    : options.issuer.startsWith('http://')
      ? [options.issuer, options.issuer.replace(/^http:/, 'https:')]
      : [options.issuer];

  return {
    async verify(token: string): Promise<AuthContext> {
      const j = await jose();
      jwks ??= j.createRemoteJWKSet(
        new URL(options.jwksUri ?? `${options.issuer}/protocol/openid-connect/certs`),
      );
      const { payload, protectedHeader } = await j.jwtVerify(token, jwks, {
        issuer: issuerVariants,
        ...(options.audience ? { audience: options.audience } : {}),
      });
      // Keycloak stamps ID tokens with typ "ID". They pass signature and
      // azp checks like access tokens, but must never authenticate API calls.
      if (protectedHeader.typ === 'ID') {
        throw new Error('ID token presented where an access token is required');
      }
      const realmAccess = payload.realm_access as { roles?: string[] } | undefined;
      const aud = Array.isArray(payload.aud) ? payload.aud.join(', ') : payload.aud;
      return {
        subject: String(payload.sub ?? ''),
        username: String(payload.preferred_username ?? payload.client_id ?? ''),
        roles: realmAccess?.roles ?? [],
        audience: aud !== undefined ? String(aud) : undefined,
        claims: payload,
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
        grant_type: 'client_credentials',
        client_id: options.clientId,
        client_secret: options.clientSecret,
      });
      const res = await doFetch(options.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!res.ok) throw new Error(`Token fetch failed (${res.status}) from ${options.tokenUrl}`);
      const json = (await res.json()) as { access_token: string; expires_in: number };
      cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
      return json.access_token;
    },
  };
}
