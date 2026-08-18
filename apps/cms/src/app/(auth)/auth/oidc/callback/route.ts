import { NextResponse, type NextRequest } from 'next/server';
import payloadConfig from '@payload-config';
import { generatePayloadCookie, getPayload, jwtSign } from 'payload';
import { createTokenVerifier } from '@xitter/auth';
import { createLogger } from '@xitter/observability';
import {
  CMS_ADMIN_ROLE,
  adminRealmIssuer,
  findOrCreateAdminUser,
} from '@/auth/keycloak-strategy';
import { callbackUrl, cmsOidcConfig, oidc, publicOrigin } from '@/auth/oidc';
import { env } from '@/env';

export const runtime = 'nodejs';

const logger = createLogger({ service: 'cms' });

function htmlResponse(body: string, status: number, origin: string): NextResponse {
  return new NextResponse(
    `<!doctype html><html><body style="font-family: system-ui; padding: 2rem;">
      <h1>Sign-in failed</h1><p>${body}</p>
      <p><a href="${origin}/cms/admin">Try again</a></p>
    </body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

/**
 * OIDC code-flow completion: exchange the code, require the app-admin realm
 * role (spec 07 - CMS gate), map to a users doc, then mint a standard Payload
 * session cookie so the admin panel sees a normal logged-in user.
 */
export async function GET(request: NextRequest) {
  const origin = publicOrigin(request.url, request.headers);
  const state = request.cookies.get('xitter_cms_oidc_state')?.value;
  const nonce = request.cookies.get('xitter_cms_oidc_nonce')?.value;
  const codeVerifier = request.cookies.get('xitter_cms_oidc_verifier')?.value;
  const returnTo = request.cookies.get('xitter_cms_oidc_return')?.value ?? '/admin';

  if (!state || !nonce || !codeVerifier) {
    return htmlResponse('Sign-in session expired - start again.', 400, origin);
  }

  try {
    const config = await cmsOidcConfig();
    // openid-client validates the callback URL against the registered
    // redirect_uri: rebuild it on the public origin with the original query.
    const currentUrl = new URL(callbackUrl(request.url, request.headers));
    currentUrl.search = request.nextUrl.search;
    const tokenSet = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedNonce: nonce,
      expectedState: state,
    });

    if (!tokenSet.access_token) throw new Error('token set has no access token');

    // The ID token proves the browser session; the ACCESS token is what the
    // CMS trusts (realm roles live there, and ID tokens must never authorise
    // API calls - see @xitter/auth createTokenVerifier).
    const verifier = createTokenVerifier({ issuer: adminRealmIssuer() });
    const auth = await verifier.verify(tokenSet.access_token);
    if (!auth.roles.includes(CMS_ADMIN_ROLE)) {
      return htmlResponse(
        'Your account does not have the app-admin role required for the CMS.',
        403,
        origin,
      );
    }

    const payload = await getPayload({ config: payloadConfig });
    const user = await findOrCreateAdminUser(payload, auth);

    const { token } = await jwtSign({
      fieldsToSign: { id: user.id, collection: 'users', email: user.email },
      secret: env.PAYLOAD_SECRET,
      tokenExpiration: 7200,
    });
    const usersConfig = payload.config.collections.find((c) => c.slug === 'users')!;
    const sessionCookie = generatePayloadCookie({
      collectionAuthConfig: usersConfig.auth,
      cookiePrefix: payload.config.cookiePrefix,
      token,
    });

    const response = NextResponse.redirect(new URL(returnTo, origin));
    response.headers.append('set-cookie', sessionCookie);
    // ID token kept briefly for the end-session hint on logout.
    if (tokenSet.id_token) {
      response.cookies.set({
        name: 'xitter_cms_oidc_id',
        value: tokenSet.id_token,
        httpOnly: true,
        sameSite: 'lax',
        path: '/cms',
        maxAge: 7200,
      });
    }
    for (const name of ['state', 'nonce', 'verifier', 'return']) {
      response.cookies.delete(`xitter_cms_oidc_${name}`);
    }
    return response;
  } catch (err) {
    logger.warn({ err }, 'CMS OIDC callback failed');
    return htmlResponse('Sign-in could not be completed. Try again.', 502, origin);
  }
}
