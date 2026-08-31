import { postgresAdapter } from '@payloadcms/db-postgres';
import { lexicalEditor } from '@payloadcms/richtext-lexical';
import { buildConfig } from 'payload';
import { isDeployedEnv } from '@xitter/config';
import { env } from './env';
import { Users } from './collections/users';
import { AboutContent } from './collections/about-content';
import { Faq } from './collections/faq';
import { Pages } from './collections/pages';

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
    push: !isDeployedEnv(),
  }),
  collections: [Users, AboutContent, Faq, Pages],
  typescript: { outputFile: 'src/payload-types.ts' },
  admin: {
    user: Users.slug,
    // Brand mark (#143): the same indigo→cyan ✕ as the web app; basePath is
    // prepended by hand because the URL is passed through to generated
    // metadata, not resolved against the app router.
    meta: { icons: { icon: '/cms/brand-mark.svg' } },
    livePreview: {
      // Both content collections render on the About page (#153) - the web
      // app shows drafts there when a preview param is present. Pages
      // (#215) each render at their own /<slug>, so their preview URL
      // carries the doc's slug.
      url: ({ data, collectionConfig }) => {
        const doc = data as { id?: number | string; slug?: string };
        const id = doc.id ?? '';
        if (collectionConfig?.slug === Pages.slug) {
          return `${env.WEB_URL}/${doc.slug ?? ''}?preview=${id}`;
        }
        return `${env.WEB_URL}/about?preview=${id}`;
      },
      collections: [AboutContent.slug, Faq.slug, Pages.slug],
    },
  },
});
