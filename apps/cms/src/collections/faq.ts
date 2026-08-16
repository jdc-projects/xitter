import type { CollectionConfig } from 'payload';

export const Faq: CollectionConfig = {
  slug: 'faq',
  admin: { useAsTitle: 'question' },
  access: { read: () => true },
  fields: [
    { name: 'question', type: 'text', required: true },
    { name: 'answer', type: 'textarea', required: true },
    { name: 'order', type: 'number', defaultValue: 0 },
  ],
};
