// Readiness probe. Intentionally checks nothing downstream: page SSR fetches
// fail soft per the product resilience rules, so a slow feed or social API
// must not pull web out of rotation - probe depth belongs to the services.
import { NextResponse } from 'next/server';

export function GET() {
  return NextResponse.json({ status: 'ok' });
}
