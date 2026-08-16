import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { oidc, oidcConfig } from '@/lib/auth/oidc';
import { valkeyStores } from '@/lib/auth/session-store';
import { SESSION_COOKIE, webEnv } from '@/lib/server-env';

export const runtime = 'nodejs';

/**
 * Logout: clears the local session, then redirects through Keycloak's
 * end-session endpoint (with the id token as hint) so the SSO session dies
 * too (ADR 0006).
 */
export async function POST() {
  const base = webEnv().appBaseUrl;
  const jar = await cookies();
  const sessionId = jar.get(SESSION_COOKIE)?.value;

  const record = sessionId ? await valkeyStores().sessions.get(sessionId) : null;
  if (sessionId) await valkeyStores().sessions.delete(sessionId);

  let target = '/';
  if (record?.idToken) {
    const config = await oidcConfig();
    target = oidc
      .buildEndSessionUrl(config, {
        id_token_hint: record.idToken,
        post_logout_redirect_uri: `${base}/`,
      })
      .toString();
  }

  const response = NextResponse.redirect(target, 303);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
