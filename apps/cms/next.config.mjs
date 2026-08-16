import { withPayload } from '@payloadcms/next/withPayload';

/** @type {import('next').NextConfig} */
const config = {
  // The CMS is mounted under /cms by the edge; assets use basePath to match.
  basePath: '/cms',
  // Minimal self-contained server output for the container image
  // (apps/cms/Dockerfile); no `next start` runtime needed.
  output: 'standalone',
};

export default withPayload(config);
