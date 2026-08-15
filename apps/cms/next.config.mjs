import { withPayload } from "@payloadcms/next/withPayload";

/** @type {import('next').NextConfig} */
const config = {
  // The CMS is mounted under /cms by the edge; assets use basePath to match.
  basePath: "/cms",
};

export default withPayload(config);
