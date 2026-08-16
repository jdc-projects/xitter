import { NextResponse } from 'next/server';
import { verifyCaptcha } from '@/lib/auth/captcha';
import { oidc, oidcConfig } from '@/lib/auth/oidc';
import { sanitizeNextPath } from '@/lib/auth/session';
import { valkeyStores } from '@/lib/auth/session-store';
import { webEnv } from '@/lib/server-env';

export const runtime = 'nodejs';

/**
 * Login entry point: form POST -> (captcha verified server-side) -> 303 to
 * Keycloak's authorization endpoint with PKCE + state + nonce. The PKCE
 * verifier lives in Valkey keyed by the random state (single-use).
 */
export async function POST(request: Request) {
  const form = await request.formData();
  const nextPath = sanitizeNextPath(String(form.get('next') ?? ''));
  const capToken = String(form.get('capToken') ?? '');
  const base = webEnv().appBaseUrl;

  if (webEnv().cap.enabled && !(await verifyCaptcha(capToken))) {
    return NextResponse.redirect(
      new URL(`/login?error=captcha&next=${encodeURIComponent(nextPath)}`, base),
      303,
    );
  }

  const config = await oidcConfig();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

  await valkeyStores().logins.set(state, { codeVerifier, nonce, next: nextPath }, 600);

  const authorizationUrl = oidc.buildAuthorizationUrl(config, {
    redirect_uri: `${base}/api/auth/callback`,
    scope: 'openid profile',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return NextResponse.redirect(authorizationUrl, 303);
}
