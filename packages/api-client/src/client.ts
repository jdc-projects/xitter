import { createJwtCache, realmUrls } from '@xitter/auth';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ServiceClientOptions {
  /** Base URL of the service root, e.g. http://localhost:8101 */
  baseUrl: string;
  /**
   * Bearer token for the request. User flows pass the user's access token;
   * machine flows omit it and use the internal client-credentials provider.
   */
  token?: string;
  /** Machine-to-machine credentials (internal endpoints). */
  internal?: { tokenUrl: string; clientId: string; clientSecret: string };
  /** Per-request timeout; hung upstreams must not hang callers (default 5s). */
  timeoutMs?: number;
  /**
   * Note: covers the service request only. Internal clients' first request
   * also awaits a client-credentials token from Keycloak, which is currently
   * unbounded (follow-up when a hung issuer matters).
   */
  fetchImpl?: typeof fetch;
}

export class ServiceClient {
  private readonly fetchImpl: typeof fetch;
  private readonly jwtCache?: ReturnType<typeof createJwtCache>;

  constructor(private readonly options: ServiceClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (options.internal && !options.token) {
      this.jwtCache = createJwtCache({
        tokenUrl: options.internal.tokenUrl,
        clientId: options.internal.clientId,
        clientSecret: options.internal.clientSecret,
        fetchImpl: this.fetchImpl,
      });
    }
  }

  protected async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<T> {
    const token = this.options.token ?? (this.jwtCache ? await this.jwtCache.get() : undefined);
    const url = new URL(`${this.options.baseUrl.replace(/\/$/, '')}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }

    const res = await this.fetchImpl(url, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
    });

    if (!res.ok) {
      const text = await res.text();
      let code = 'unknown';
      let message = text;
      try {
        const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
        code = parsed.error?.code ?? code;
        message = parsed.error?.message ?? message;
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(res.status, code, message);
    }

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  protected get<T>(path: string, query?: Record<string, string>): Promise<T> {
    return this.request<T>('GET', path, undefined, query);
  }

  protected post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  protected patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  protected delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}

/** Standard internal token URL for the demo realm. */
export function internalTokenUrl(keycloakBaseUrl: string, realm: string): string {
  return realmUrls(keycloakBaseUrl, realm).token;
}

/**
 * The internal client-credentials triple for a worker's API clients, from
 * the standard worker env (KEYCLOAK_BASE_URL / DEMO_REALM /
 * KEYCLOAK_CLIENT_ID / KEYCLOAK_CLIENT_SECRET) - one shape shared by every
 * worker main instead of a per-worker rewrite of the same object.
 */
export function internalCredentials(env: {
  KEYCLOAK_BASE_URL: string;
  DEMO_REALM: string;
  KEYCLOAK_CLIENT_ID: string;
  KEYCLOAK_CLIENT_SECRET: string;
}): { tokenUrl: string; clientId: string; clientSecret: string } {
  return {
    tokenUrl: internalTokenUrl(env.KEYCLOAK_BASE_URL, env.DEMO_REALM),
    clientId: env.KEYCLOAK_CLIENT_ID,
    clientSecret: env.KEYCLOAK_CLIENT_SECRET,
  };
}
