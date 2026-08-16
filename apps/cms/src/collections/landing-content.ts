import type { CollectionConfig } from 'payload';

export const LandingContent: CollectionConfig = {
  slug: 'landing-content',
  admin: { useAsTitle: 'title' },
  access: { read: () => true },
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'intro', type: 'textarea', required: true },
    { name: 'order', type: 'number', defaultValue: 0 },
  ],
};
