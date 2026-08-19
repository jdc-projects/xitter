import { NextResponse, type NextRequest } from 'next/server';
import { publicOrigin } from '@/auth/oidc';
import { env } from '@/env';

export const runtime = 'nodejs';

/**
 * Log out of the CMS fully: clear the Payload session, then end the Keycloak
 * SSO session so the next /admin visit goes through a fresh login. Payload's
 * own logout button only clears its cookie and lands on /admin/login, which
 * the middleware redirects here.
 */
export async function GET(request: NextRequest) {
  const origin = publicOrigin(request.url, request.headers);
  const idToken = request.cookies.get('xitter_cms_oidc_id')?.value;

  const endSession = new URL(
    `${env.KEYCLOAK_BASE_URL.replace(/\/$/, '')}/realms/${env.ADMIN_REALM}/protocol/openid-connect/logout`,
  );
  endSession.searchParams.set('client_id', env.CMS_CLIENT_ID);
  endSession.searchParams.set('post_logout_redirect_uri', `${origin}/cms/admin`);
  if (idToken) endSession.searchParams.set('id_token_hint', idToken);

  const response = NextResponse.redirect(endSession);
  response.cookies.delete('payload-token');
  response.cookies.delete('xitter_cms_oidc_id');
  return response;
}
