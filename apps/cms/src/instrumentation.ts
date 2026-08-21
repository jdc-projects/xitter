/**
 * Next.js instrumentation hook: server-side Sentry for cms (spec 06).
 * Only the nodejs runtime initialises - there is no Node process on the edge.
 * No-op unless SENTRY_DSN is set, so local runs without Sentry stay quiet.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { initSentry } = await import('@xitter/observability');
  initSentry('cms');
}
