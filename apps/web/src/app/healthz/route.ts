// Liveness probe for container orchestrators (kubelet/docker httpGet).
// Root-level on purpose: probe traffic carries no session, so this must not
// sit inside the (app) route group or behind any auth gating. The Next
// server being able to answer is itself health - web has no boot-time
// dependencies.
import { NextResponse } from 'next/server';

export function GET() {
  return NextResponse.json({ status: 'ok' });
}
