import { getAccessToken } from '../auth/session.js';

/**
 * Same-origin transport to the services' internal admin endpoints through
 * the edge (relative paths - the panel serves under /admin, APIs under
 * /api/{service}, one origin, no CORS). @xitter/api-contracts zod schemas
 * validate every response at this boundary, mirroring what
 * @xitter/api-client does for the machine path.
 */
export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

export async function adminFetch<T>(
  path: string,
  init: { method?: string; query?: Record<string, string | undefined> } = {},
  parse?: (value: unknown) => T,
): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, value);
  }

  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${await getAccessToken()}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    let code = 'unknown';
    let message = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      /* non-JSON error body */
    }
    throw new AdminApiError(res.status, code, message);
  }

  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json();
  return parse ? parse(body) : (body as T);
}
