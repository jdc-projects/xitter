import { ColorSchemeScript, MantineProvider, createTheme } from '@mantine/core';
import type { Metadata } from 'next';
import '@mantine/core/styles.layer.css';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'xitter - a demo microservices playground',
    template: '%s | xitter',
  },
  description:
    'A Twitter/X-style demo app. Public data, reset nightly. Do not enter personal information.',
};

// Shade 8 keeps filled buttons AA-compliant (white on blue-7 is 4.0:1, on
// blue-6 3.5:1). Gray shade 6 darkened: it's the dimmed token, which fails
// AA (3.3:1) on light backgrounds at Mantine's default. Orange shade 7
// likewise (3.0:1): it's the PII-reminder text colour on white.
const theme = createTheme({
  primaryShade: 8,
  colors: {
    gray: [
      '#f8f9fa',
      '#f1f3f5',
      '#e9ecef',
      '#dee2e6',
      '#ced4da',
      '#adb5bd',
      '#5c5f66',
      '#495057',
      '#343a40',
      '#212529',
    ],
    orange: [
      '#fff4e6',
      '#ffe8cc',
      '#ffd8a8',
      '#ffc078',
      '#ffa94d',
      '#ff922b',
      '#fd7e14',
      '#c2410c',
      '#e8590c',
      '#d9480f',
    ],
  },
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Sentry client config (spec 06): the DSN is a runtime secret injected by
  // Tofu, so the server passes it to instrumentation-client.ts via this JSON
  // script tag instead of a build-time NEXT_PUBLIC_ inlining.
  const sentryConfig = JSON.stringify({
    dsn: process.env.SENTRY_DSN,
    release: process.env.SENTRY_RELEASE,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.XITTER_ENV ?? 'local',
  });

  return (
    <html lang="en">
      <head>
        <ColorSchemeScript defaultColorScheme="auto" />
        <script id="xitter-sentry-config" type="application/json">
          {sentryConfig}
        </script>
      </head>
      <body>
        <MantineProvider theme={theme} defaultColorScheme="auto">
          {children}
        </MantineProvider>
      </body>
    </html>
  );
}
