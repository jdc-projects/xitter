import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactCompiler: true,
  // Minimal self-contained server output for the container image
  // (apps/web/Dockerfile); no `next start` runtime needed.
  output: 'standalone',
  // SSR calls services over the local network; ports are env-driven via
  // @xitter/api-client. Assets are served same-origin through the edge.
  poweredByHeader: false,
  // ioredis keeps TCP connections and openid-client is ESM-only - keep both
  // out of the server bundle.
  serverExternalPackages: ['ioredis', 'openid-client'],
};

export default nextConfig;
