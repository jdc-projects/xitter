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
// AA (3.3:1) on light backgrounds at Mantine's default.
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
  },
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <ColorSchemeScript defaultColorScheme="auto" />
      </head>
      <body>
        <MantineProvider theme={theme} defaultColorScheme="auto">
          {children}
        </MantineProvider>
      </body>
    </html>
  );
}
