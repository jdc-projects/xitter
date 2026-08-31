import { NextResponse, type NextRequest } from 'next/server';
import payloadConfig from '@payload-config';
import { getPayload, jwtSign, type Payload } from 'payload';
import { createTokenVerifier, type AuthContext } from '@xitter/auth';
import { createLogger } from '@xitter/observability';
import { CMS_ADMIN_ROLE, adminRealmIssuer, findOrCreateAdminUser } from '@/auth/keycloak-strategy';
import { callbackUrl, cmsOidcConfig, oidc, publicOrigin } from '@/auth/oidc';

export const runtime = 'nodejs';

const logger = createLogger({ service: 'cms' });

/** Short-lived cookies carrying the OIDC transaction (state/nonce/PKCE). */
const FLOW_COOKIE_PREFIX = 'xitter_cms_oidc_';
const SESSION_SECONDS = 7200;

function failurePage(origin: string, body: string, status: number): NextResponse {
  // The origin is request-derived (host/x-forwarded-host) - escape it so a
  // hostile Host can't inject markup into the error page.
  const safeOrigin = origin.replace(/[^a-zA-Z0-9.:/-]/g, '');
  return new NextResponse(
    `<!doctype html><html><body style="font-family: system-ui; padding: 2rem;">
      <h1>Sign-in failed</h1><p>${body}</p>
      <p><a href="${safeOrigin}/cms/admin">Try again</a></p>
    </body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

/** Exchange the authorization code, enforcing state + nonce + PKCE. */
async function completeCodeFlow(
  request: NextRequest,
  flow: { state: string; nonce: string; verifier: string },
): Promise<{ access_token?: string; id_token?: string }> {
  const config = await cmsOidcConfig();
  // openid-client validates the callback URL against the registered
  // redirect_uri: rebuild it on the public origin with the original query.
  const currentUrl = new URL(callbackUrl(request.url, request.headers));
  currentUrl.search = request.nextUrl.search;
  const tokenSet = await oidc.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: flow.verifier,
    expectedNonce: flow.nonce,
    expectedState: flow.state,
  });
  return tokenSet as { access_token?: string; id_token?: string };
}

/** Verify the access token carries the app-admin realm role (spec 07). */
async function requireAppAdmin(accessToken: string): Promise<AuthContext> {
  const auth = await createTokenVerifier({ issuer: adminRealmIssuer() }).verify(accessToken);
  if (!auth.roles.includes(CMS_ADMIN_ROLE)) {
    throw new Error('missing app-admin role');
  }
  return auth;
}

/** Mint a standard Payload session cookie value for the mapped user. */
async function mintSessionToken(payload: Payload, auth: AuthContext): Promise<string> {
  const user = await findOrCreateAdminUser(payload, auth);
  const { token } = await jwtSign({
    fieldsToSign: { id: user.id, collection: 'users', email: user.email },
    // Payload signs/verifies session JWTs with the DERIVED secret
    // (sha256 of the config secret, see payload init) - the raw env value
    // would mint a cookie the local-jwt strategy always rejects.
    secret: payload.secret,
    tokenExpiration: SESSION_SECONDS,
  });
  return token;
}

/**
 * OIDC code-flow completion: exchange the code, require the app-admin realm
 * role (spec 07 - CMS gate), map to a users doc, then set a standard Payload
 * session cookie so the admin panel sees a normal logged-in user.
 */
export async function GET(request: NextRequest) {
  const origin = publicOrigin(request.url, request.headers);
  const read = (name: string) => request.cookies.get(`${FLOW_COOKIE_PREFIX}${name}`)?.value;
  const flow = {
    state: read('state') ?? '',
    nonce: read('nonce') ?? '',
    verifier: read('verifier') ?? '',
    returnTo: read('return') ?? '/admin',
  };
  if (!flow.state || !flow.nonce || !flow.verifier) {
    return failurePage(origin, 'Sign-in session expired - start again.', 400);
  }

  try {
    const tokenSet = await completeCodeFlow(request, flow);
    if (!tokenSet.access_token) throw new Error('token set has no access token');
    // The ID token proves the browser session; the ACCESS token is what the
    // CMS trusts (realm roles live there, and ID tokens must never authorise
    // API calls - see @xitter/auth createTokenVerifier).
    const auth = await requireAppAdmin(tokenSet.access_token);

    const payload = await getPayload({ config: payloadConfig });
    const token = await mintSessionToken(payload, auth);

    const response = NextResponse.redirect(new URL(`/cms${flow.returnTo}`, origin));
    // Standard Payload session cookie, set through the cookies API: a raw
    // set-cookie append gets clobbered by the cookie mutations below.
    response.cookies.set({
      name: `${payload.config.cookiePrefix}-token`,
      value: token,
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      expires: new Date(Date.now() + SESSION_SECONDS * 1000),
      secure: origin.startsWith('https://'),
    });
    // ID token kept briefly for the end-session hint on logout.
    if (tokenSet.id_token) {
      response.cookies.set({
        name: `${FLOW_COOKIE_PREFIX}id`,
        value: tokenSet.id_token,
        httpOnly: true,
        sameSite: 'lax',
        path: '/cms',
        maxAge: SESSION_SECONDS,
      });
    }
    for (const name of ['state', 'nonce', 'verifier', 'return']) {
      // Path must match the set cookies (/cms) or the browser keeps them
      // until their 600s TTL instead of expiring now.
      response.cookies.delete({ name: `${FLOW_COOKIE_PREFIX}${name}`, path: '/cms' });
    }
    return response;
  } catch (err) {
    const missingRole = err instanceof Error && err.message === 'missing app-admin role';
    if (missingRole) {
      return failurePage(
        origin,
        'Your account does not have the app-admin role required for the CMS.',
        403,
      );
    }
    logger.warn({ err }, 'CMS OIDC callback failed');
    return failurePage(origin, 'Sign-in could not be completed. Try again.', 502);
  }
}
