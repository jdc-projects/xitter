/**
 * Shared HTTP helper for the env-targeting scripts (seed, content, reset):
 * one request function so they share auth headers and error formatting.
 * Bodies are JSON values (stringified here); binary uploads use raw fetch.
 */

export class RequestError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    body: string,
  ) {
    super(`${method} ${path} -> ${status}: ${body}`);
    this.name = 'RequestError';
  }
}

export interface JsonRequest {
  method?: string;
  headers?: Record<string, string>;
  /** JSON-serialised into the request body. */
  body?: unknown;
}

/** JSON request with optional bearer auth; non-2xx rejects with the body. */
export async function requestJson(
  baseUrl: string,
  path: string,
  init: JsonRequest = {},
  token?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new RequestError(init.method ?? 'GET', path, res.status, text);
  return text ? JSON.parse(text) : null;
}
