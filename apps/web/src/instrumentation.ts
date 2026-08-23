/**
 * Next.js instrumentation hook: server-side Sentry for web SSR (spec 06)
 * and boot-time config validation. The edge runtime has no Node process -
 * only the nodejs runtime initialises. No-op unless SENTRY_DSN is set, so
 * local runs without Sentry stay quiet; webEnv() throws on invalid config
 * (e.g. XITTER_CAP_REQUIRED without captcha enabled), so a misconfigured
 * deployment crashloops at boot instead of serving a silently unprotected
 * login form.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { initSentry } = await import('@xitter/observability');
  initSentry('web');
  // Extensionless: Turbopack does not map the .js suffix onto .ts sources
  // in this hook's compilation context.
  const { webEnv } = await import('./lib/server-env');
  webEnv();
}
