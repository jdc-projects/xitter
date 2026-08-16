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
  const record = await store.get(id);
  if (!record) return null;

  if (Date.now() < record.expiresAt) return toSession(id, record);
  if (!record.refreshToken) {
    await store.delete(id);
    return null;
  }

  try {
    const config = await oidcConfig();
    const tokens = await oidc.refreshTokenGrant(config, record.refreshToken);
    const refreshed: SessionRecord = {
      ...recordFromTokens(tokens),
      // Keycloak rotates refresh tokens; keep the old one when the response
      // omits it (some providers reuse the original).
      refreshToken: tokens.refresh_token ?? record.refreshToken,
    };
    await store.save(id, refreshed);
    return toSession(id, refreshed);
  } catch {
    await store.delete(id);
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
