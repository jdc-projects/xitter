import { postgresAdapter } from '@payloadcms/db-postgres';
import { lexicalEditor } from '@payloadcms/richtext-lexical';
import { buildConfig } from 'payload';
import { env, isEphemeralEnv } from './env';
import { Users } from './collections/users';
import { LandingContent } from './collections/landing-content';
import { Faq } from './collections/faq';

/**
 * CMS for site content (not user-generated content). Auth bridges to the
 * admin Keycloak realm (see collections/users.ts) - demo realm users cannot
 * log in here.
 */
export default buildConfig({
  secret: env.PAYLOAD_SECRET,
  editor: lexicalEditor(),
  db: postgresAdapter({
    pool: { connectionString: env.DATABASE_URL },
    // Local/CI boots push the schema automatically (no migration files for a
    // disposable demo database); deployed environments manage migrations.
    push: isEphemeralEnv(),
  }),
  collections: [Users, LandingContent, Faq],
  typescript: { outputFile: 'src/payload-types.ts' },
  admin: {
    user: Users.slug,
    livePreview: {
      url: ({ data, collectionConfig }) => {
        const id = (data as { id?: number | string }).id ?? '';
        // The web app renders drafts when a preview param is present.
        return collectionConfig?.slug === Faq.slug
          ? `${env.WEB_URL}/about?preview=${id}`
          : `${env.WEB_URL}/?preview=${id}`;
      },
      collections: [LandingContent.slug, Faq.slug],
    },
  },
});
