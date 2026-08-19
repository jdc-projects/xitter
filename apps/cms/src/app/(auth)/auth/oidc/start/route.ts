import { NextResponse, type NextRequest } from 'next/server';
import { callbackUrl, oidc, cmsOidcConfig } from '@/auth/oidc';

export const runtime = 'nodejs';

/** Short-lived cookies carrying the OIDC transaction (state/nonce/PKCE). */
const FLOW_COOKIE_MAX_AGE = 600;

function flowCookie(response: NextResponse, name: string, value: string) {
  response.cookies.set({
    name,
    value,
    httpOnly: true,
    sameSite: 'lax',
    // Next basePath - all CMS routes (including these) live under /cms.
    path: '/cms',
    maxAge: FLOW_COOKIE_MAX_AGE,
  });
}

/**
 * Admin-panel login entry point: redirect to the admin realm's authorization
 * endpoint with PKCE. Payload's own login form is bypassed entirely - the
 * proxy sends every unauthenticated /admin visit here.
 *
 * GET-with-cookies is inherent to a login kickoff route reached via redirect
 * (same shape as Keycloak's own login URL); the cookies are single-use
 * short-lived CSRF/nonce carriers, so replay is harmless.
 */
// react-doctor-disable-next-line nextjs-no-side-effect-in-get-handler
export async function GET(request: NextRequest) {
  const config = await cmsOidcConfig();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

  const requested = request.nextUrl.searchParams.get('returnTo');
  const returnTo = requested?.startsWith('/admin') ? requested : '/admin';

  const authorizationUrl = oidc.buildAuthorizationUrl(config, {
    redirect_uri: callbackUrl(request.url, request.headers),
    scope: 'openid',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  const response = NextResponse.redirect(authorizationUrl);
  flowCookie(response, 'xitter_cms_oidc_state', state);
  flowCookie(response, 'xitter_cms_oidc_nonce', nonce);
  flowCookie(response, 'xitter_cms_oidc_verifier', codeVerifier);
  flowCookie(response, 'xitter_cms_oidc_return', returnTo);
  return response;
}
