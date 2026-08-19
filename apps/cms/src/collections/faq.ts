import type { CollectionConfig } from 'payload';
import { siteContentAccess } from './site-content-access';

export const Faq: CollectionConfig = {
  slug: 'faq',
  admin: { useAsTitle: 'question' },
  access: siteContentAccess,
  // Drafts power live preview; only published versions render publicly.
  versions: { drafts: true },
  fields: [
    { name: 'question', type: 'text', required: true },
    { name: 'answer', type: 'textarea', required: true },
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
