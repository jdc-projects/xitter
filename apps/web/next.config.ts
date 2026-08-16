import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactCompiler: true,
  // SSR calls services over the local network; ports are env-driven via
  // @xitter/api-client. Assets are served same-origin through the edge.
  poweredByHeader: false,
  // Minimal self-contained server output for the container image
  // (apps/web/Dockerfile); no `next start` runtime needed.
  output: 'standalone',
};

export default nextConfig;
