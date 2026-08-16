// Readiness probe (served at /cms/readyz - see next.config.mjs basePath).
// Plain 200 by design: pulling the Payload config into a route handler just
// to ping its database is not worth the import-graph risk here. If the CMS
// database is down its pages 500, but the pod staying Ready is acceptable
// for this environment - probe depth belongs to the Nest services.
import { NextResponse } from 'next/server';

export function GET() {
  return NextResponse.json({ status: 'ok' });
}
