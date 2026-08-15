import { postgresAdapter } from "@payloadcms/db-postgres";
import { lexicalEditor } from "@payloadcms/richtext-lexical";
import { buildConfig } from "payload";
import { env } from "./env.js";
import { LandingContent } from "./collections/landing-content.js";
import { Faq } from "./collections/faq.js";

/**
 * CMS for site content (not user-generated content). Auth uses the admin
 * Keycloak realm (locally emulated); demo realm users cannot log in here.
 */
export default buildConfig({
  secret: env.PAYLOAD_SECRET,
  editor: lexicalEditor(),
  db: postgresAdapter({ pool: { connectionString: env.DATABASE_URL } }),
  collections: [LandingContent, Faq],
  typescript: { outputFile: "src/payload-types.ts" },
  livePreview: {
    url: ({ data }) => `${env.WEB_URL}/?preview=${(data as { id?: string }).id ?? ""}`,
    collections: ["landing-content"],
  },
});
