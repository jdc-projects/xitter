import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { oidc, oidcConfig } from './oidc';
import { valkeyStores, type SessionRecord, type SessionStore } from './session-store';
import { SESSION_COOKIE } from '../server-env';

export interface Session {
  id: string;
  subject: string;
  username: string;
  accessToken: string;
}

/** Refresh a little before real expiry to absorb clock skew. */
const EXPIRY_SKEW_MS = 30_000;

/**
 * One refresh grant in flight per session id: layout and page render both
 * call getSession() concurrently and must share it - two grants with the
 * same refresh token would log the user out under rotation. Module state is
 * fine on the long-lived node server (no serverless recycling).
 */
const refreshInFlight = new Map<string, Promise<Session | null>>();

export function recordFromTokens(
  tokens: Awaited<ReturnType<typeof oidc.refreshTokenGrant>>,
): SessionRecord {
  const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : 900;
  return {
    subject: String(tokens.claims()?.sub ?? ''),
    username: String(tokens.claims()?.preferred_username ?? ''),
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    expiresAt: Date.now() + expiresIn * 1000 - EXPIRY_SKEW_MS,
  };
}

function toSession(id: string, record: SessionRecord): Session {
  return {
    id,
    subject: record.subject,
    username: record.username,
    accessToken: record.accessToken,
  };
}

/**
 * Load a session, silently refreshing the access token when stale. A failed
 * refresh destroys the session (logged out). Returns null when there is no
 * usable session - callers decide between redirect and rendering.
 */
export async function resolveSession(
  store: SessionStore,
  id: string | undefined,
): Promise<Session | null> {
  if (!id) return null;

  // Store outage (Valkey down): treat as signed out - a redirect to login
  // beats an unhandled 500 on every authenticated page.
  let record: SessionRecord | null;
  try {
    record = await store.get(id);
  } catch {
    return null;
  }
  if (!record) return null;

  if (Date.now() < record.expiresAt) return toSession(id, record);
  if (!record.refreshToken) {
    await store.delete(id).catch(() => undefined);
    return null;
  }

  const inFlight = refreshInFlight.get(id);
  if (inFlight) return inFlight;

  const refreshToken = record.refreshToken;
  const refresh = refreshSession(store, id, refreshToken).finally(() => refreshInFlight.delete(id));
  refreshInFlight.set(id, refresh);
  return refresh;
}

async function refreshSession(
  store: SessionStore,
  id: string,
  refreshToken: string,
): Promise<Session | null> {
  try {
    const config = await oidcConfig();
    const tokens = await oidc.refreshTokenGrant(config, refreshToken);
    const refreshed: SessionRecord = {
      ...recordFromTokens(tokens),
      // The demo realm does not rotate refresh tokens, so the response may
      // omit one - keep the stored token rather than dropping the session.
      refreshToken: tokens.refresh_token ?? refreshToken,
    };
    await store.save(id, refreshed);
    return toSession(id, refreshed);
  } catch {
    // Refresh rejected, or the store is down mid-refresh: unusable either
    // way. Cleanup is best-effort (the store may be the thing that failed).
    await store.delete(id).catch(() => undefined);
    return null;
  }
}

/** Current session for server components/route handlers (cookie-based). */
export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  const { sessions } = valkeyStores();
  return resolveSession(sessions, id);
}

/**
 * Server-component gate: unauthenticated visitors are redirected to
 * `/login?next=...` before any user content is fetched (ADR 0002).
 */
export async function requireSession(next = '/feed'): Promise<Session> {
  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(next)}`);
  return session;
}

/** Only site-relative paths - blocks open redirects via `next`. */
export function sanitizeNextPath(value: string | undefined | null, fallback = '/feed'): string {
  if (value && value.startsWith('/') && !value.startsWith('//')) return value;
  return fallback;
}
