import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactCompiler: true,
  // SSR calls services over the local network; ports are env-driven via
  // @xitter/api-client. Assets are served same-origin through the edge.
  poweredByHeader: false,
  // ioredis keeps TCP connections - it must not be bundled.
  serverExternalPackages: ['ioredis'],
};

export default nextConfig;
