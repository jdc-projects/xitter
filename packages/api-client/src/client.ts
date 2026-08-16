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
