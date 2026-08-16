import { NextResponse } from 'next/server';
import { SocialClient, localServiceUrls, ApiError } from '@xitter/api-client';
import { oidc, oidcConfig } from '@/lib/auth/oidc';
import { recordFromTokens, type Session } from '@/lib/auth/session';
import { valkeyStores, type LoginState } from '@/lib/auth/session-store';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, webEnv } from '@/lib/server-env';

export const runtime = 'nodejs';

function loginRedirect(base: string, reason: string, next?: string): NextResponse {
  const target = new URL('/login', base);
  target.searchParams.set('error', reason);
  // Keep the destination across error redirects so a retry returns there.
  if (next) target.searchParams.set('next', next);
  return NextResponse.redirect(target, 303);
}

/**
 * Idempotent profile bootstrap: social owns profiles, Keycloak does not. On
 * first login the profile is missing (404) and gets created; later logins are
 * a no-op read. Best-effort by design - a social outage must not block login.
 */
async function ensureProfile(session: Omit<Session, 'id'>): Promise<void> {
  const social = new SocialClient({
    baseUrl: localServiceUrls().social,
    token: session.accessToken,
  });
  try {
    await social.getProfile(session.subject);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      await social.createProfile(session.subject, {}).catch(() => undefined);
    }
  }
}

/**
 * OIDC redirect target: validates state (+ nonce, PKCE), exchanges the code,
 * stores tokens server-side, and sets an opaque httpOnly session cookie.
 */
export async function GET(request: Request) {
  const base = webEnv().appBaseUrl;
  const requestUrl = new URL(request.url);
  // Normalise against the configured origin - behind the edge proxy the
  // absolute request URL may differ from the public one.
  const callbackUrl = new URL(requestUrl.pathname + requestUrl.search, base);

  const error = callbackUrl.searchParams.get('error');
  if (error) return loginRedirect(base, 'oidc');

  const state = callbackUrl.searchParams.get('state');
  if (!state) return loginRedirect(base, 'state');

  let login: LoginState | null;
  try {
    login = await valkeyStores().logins.take(state);
  } catch {
    // Store outage: the state cannot be validated - clean bounce to login.
    return loginRedirect(base, 'state');
  }
  if (!login) return loginRedirect(base, 'state');

  try {
    const config = await oidcConfig();
    const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: login.codeVerifier,
      expectedState: state,
      expectedNonce: login.nonce,
    });

    const record = recordFromTokens(tokens);
    const sessionId = await valkeyStores().sessions.create(record);
    await ensureProfile({
      subject: record.subject,
      username: record.username,
      accessToken: record.accessToken,
    });
    const response = NextResponse.redirect(new URL(login.next, base), 303);
    response.cookies.set(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: base.startsWith('https://'),
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    });
    return response;
  } catch {
    return loginRedirect(base, 'callback', login.next);
  }
}
