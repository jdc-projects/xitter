/**
 * Next.js instrumentation hook: server-side Sentry for web SSR (spec 06).
 * The edge runtime has no Node process - only the nodejs runtime initialises.
 * No-op unless SENTRY_DSN is set, so local runs without Sentry stay quiet.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { initSentry } = await import('@xitter/observability');
  initSentry('web');
}
