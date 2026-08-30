import { withPayload } from '@payloadcms/next/withPayload';

/** @type {import('next').NextConfig} */
const config = {
  // The CMS is mounted under /cms by the edge; assets use basePath to match.
  basePath: '/cms',
  // Minimal self-contained server output for the container image
  // (apps/cms/Dockerfile); no `next start` runtime needed.
  output: 'standalone',
  async redirects() {
    // The route table makes /cms the entry point, but the Payload admin UI
    // at /admin is the whole surface - and basePath prefixes both paths (#196).
    return [{ source: '/', destination: '/admin', permanent: false }];
  },
};

export default withPayload(config);
