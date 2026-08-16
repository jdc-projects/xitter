// Liveness probe for container orchestrators. Served at /cms/healthz because
// the CMS mounts everything under the basePath configured in next.config.mjs.
// Root-level (outside the (payload) group): probes carry no admin session.
import { NextResponse } from 'next/server';

export function GET() {
  return NextResponse.json({ status: 'ok' });
}
