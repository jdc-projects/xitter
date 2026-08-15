import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  // SSR calls services over the local network; ports are env-driven via
  // @xitter/api-client. Assets are served same-origin through the edge.
  poweredByHeader: false,
};

export default nextConfig;
