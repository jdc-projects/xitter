import * as Sentry from '@sentry/nextjs';

/**
 * Client-side Sentry (web vitals + JS errors, spec 06). The DSN is a
 * deploy-time secret injected into the workload at runtime, so the server
 * renders it into a JSON script tag (layout.tsx) and this module reads it
 * before init - it cannot be inlined into the client bundle at build time.
 *
 * CWV (LCP/INP/CLS) collection ships by default with @sentry/nextjs client
 * init; the Grafana "Web vitals" story is served by Sentry's Web Vitals
 * views rather than Prometheus panels.
 */
interface SentryRuntimeConfig {
  dsn?: string;
  release?: string;
  environment?: string;
}

function readRuntimeConfig(): SentryRuntimeConfig | undefined {
  const element = document.getElementById('xitter-sentry-config');
  if (!element?.textContent) return undefined;
  try {
    return JSON.parse(element.textContent) as SentryRuntimeConfig;
  } catch {
    return undefined;
  }
}

const config = readRuntimeConfig();

if (config?.dsn) {
  Sentry.init({
    dsn: config.dsn,
    release: config.release,
    environment: config.environment ?? 'local',
    // Same `service` tag initSentry stamps server-side: one project for
    // everything, filtered per workload through this tag (spec 06).
    initialScope: { tags: { service: 'web' } },
    // Demo system: no user PII should ever exist, keep sendDefaultPii off regardless.
    sendDefaultPii: false,
  });
}
