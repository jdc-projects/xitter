import { ColorSchemeScript, MantineProvider } from '@mantine/core';
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <ColorSchemeScript defaultColorScheme="auto" />
      </head>
      <body>
        <MantineProvider defaultColorScheme="auto">{children}</MantineProvider>
      </body>
    </html>
  );
}
