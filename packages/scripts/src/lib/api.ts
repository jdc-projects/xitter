/**
 * Shared HTTP helper for the env-targeting scripts (seed, content, reset):
 * one request function so they share auth headers and error formatting.
 * Bodies are JSON values (stringified here); binary uploads use raw fetch.
 */

interface RequestError extends Error {
  method: string;
  path: string;
  status: number;
}

function requestError(method: string, path: string, status: number, body: string): RequestError {
  const err = new Error(`${method} ${path} -> ${status}: ${body}`) as RequestError;
  err.name = 'RequestError';
  err.method = method;
  err.path = path;
  err.status = status;
  return err;
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
  if (!res.ok) throw requestError(init.method ?? 'GET', path, res.status, text);
  return text ? JSON.parse(text) : null;
}

