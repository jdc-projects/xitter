import type { MetadataRoute } from 'next';

/**
 * Web manifest (#143): install basics + the generated brand icons
 * (public/brand-192.png, public/brand-512.png - regenerate with
 * `npm run icons`). The icon/apple-icon App Router file conventions cover
 * favicons and touch icons on their own.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'xitter - a demo microservices playground',
    short_name: 'xitter',
    description:
      'A Twitter/X-style demo app. Public data, reset nightly. Do not enter personal information.',
    start_url: '/',
    display: 'standalone',
    icons: [
      { src: '/brand-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/brand-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
