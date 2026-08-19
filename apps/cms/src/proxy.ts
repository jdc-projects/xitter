import { NextResponse, type NextRequest } from 'next/server';

/** Payload's default session cookie (cookiePrefix 'payload'). */
const SESSION_COOKIE = 'payload-token';

/**
 * CMS admin-panel gate (UX layer; access control stays in the collections).
 *
 * Every unauthenticated /admin visit is sent to the Keycloak admin realm via
 * the OIDC start route, bypassing Payload's unused password login form. The
 * form page itself (/admin/login, where Payload's logout button lands) is
 * treated as a logout intent and routed through Keycloak end-session.
 *
 * Matchers cover the path with and without the /cms basePath - the proxy runs
 * before basePath normalisation. (proxy.ts is the Next 16 name for
 * middleware.ts.)
 */
export function proxy(request: NextRequest) {
  // Normalise: strip the basePath if it is still present.
  let path = request.nextUrl.pathname;
  if (path === '/cms' || path.startsWith('/cms/')) path = path.slice('/cms'.length) || '/';
  if (!path.startsWith('/admin')) return NextResponse.next();

  if (path === '/admin/login' || path === '/admin/create-first-user') {
    return NextResponse.redirect(new URL('/cms/auth/oidc/logout', request.url));
  }

  if (!request.cookies.has(SESSION_COOKIE)) {
    const start = new URL('/cms/auth/oidc/start', request.url);
    start.searchParams.set('returnTo', path);
    return NextResponse.redirect(start);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/admin', '/admin/:path*', '/cms/admin', '/cms/admin/:path*'],
};
