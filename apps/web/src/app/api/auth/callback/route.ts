import { NextResponse } from 'next/server';
import { oidc, oidcConfig } from '@/lib/auth/oidc';
import { recordFromTokens } from '@/lib/auth/session';
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

    const sessionId = await valkeyStores().sessions.create(recordFromTokens(tokens));
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
