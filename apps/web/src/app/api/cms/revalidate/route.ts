import { revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';
import { createTokenVerifier } from '@xitter/auth';
import { adminRealmIssuer, CMS_CACHE_TAGS } from '@/lib/cms/content';

export const runtime = 'nodejs';

/**
 * On-demand cache refresh for published CMS content: drops the `cms-*`
 * data-cache entries so the next render re-fetches instead of waiting out
 * the 60s revalidate window. Called with a Keycloak admin-realm access token
 * carrying `app-admin` (the same principal the CMS itself authenticates), so
 * it doubles as the publish→refresh hook a Payload afterChange webhook can
 * call in deployed environments.
 */
export async function POST(request: Request) {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }
  try {
    const auth = await createTokenVerifier({ issuer: adminRealmIssuer() }).verify(
      authorization.slice('Bearer '.length),
    );
    if (!auth.roles.includes('app-admin')) {
      return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
  }

  for (const tag of CMS_CACHE_TAGS) revalidateTag(tag, 'max');
  return NextResponse.json({ revalidated: CMS_CACHE_TAGS });
}
