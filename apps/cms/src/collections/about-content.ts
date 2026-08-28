import type { CollectionConfig } from 'payload';
import { siteContentAccess } from './site-content-access';

/**
 * CMS-managed sections for the About page (#153): each doc is one section
 * (title + prose), rendered in `order` below the page title. Formerly the
 * `landing-content` collection - the landing no longer explains the app.
 */
export const AboutContent: CollectionConfig = {
  slug: 'about-content',
  admin: { useAsTitle: 'title' },
  access: siteContentAccess,
  // Drafts power live preview; only published versions render publicly.
  versions: { drafts: true },
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'intro', type: 'textarea', required: true },
    { name: 'order', type: 'number', defaultValue: 0 },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      admin: {
        description: 'Stable key for content promotion seed files - renaming breaks the upsert.',
      },
    },
  ],
};
