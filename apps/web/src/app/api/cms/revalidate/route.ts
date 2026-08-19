import { revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';
import { createTokenVerifier } from '@xitter/auth';
import { adminRealmIssuer, CMS_CACHE_TAGS } from '@/lib/cms/content';

export const runtime = 'nodejs';

const CMS_ADMIN_ROLE = 'app-admin';

/**
 * Verify a Bearer token from the Keycloak admin realm carries `app-admin` -
 * the same principal the CMS itself authenticates.
 */
async function revalidateAllowed(request: Request): Promise<boolean> {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return false;
  try {
    const auth = await createTokenVerifier({ issuer: adminRealmIssuer() }).verify(
      authorization.slice('Bearer '.length),
    );
    return auth.roles.includes(CMS_ADMIN_ROLE);
  } catch {
    return false;
  }
}

/**
 * On-demand cache refresh for published CMS content: drops the `cms-*`
 * data-cache entries so the next render re-fetches instead of waiting out
 * the 60s revalidate window. Authenticated with a Keycloak admin-realm
 * access token carrying `app-admin`, so it doubles as the publish→refresh
 * hook a Payload afterChange webhook can call in deployed environments.
 */
export async function POST(request: Request) {
  if (!(await revalidateAllowed(request))) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }
  for (const tag of CMS_CACHE_TAGS) revalidateTag(tag, 'max');
  return NextResponse.json({ revalidated: CMS_CACHE_TAGS });
}
