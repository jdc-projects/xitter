import { isReservedWebSlug } from '@xitter/config';
import type { CollectionConfig, TextFieldSingleValidation } from 'payload';
import { siteContentAccess } from './site-content-access';

/** Kebab-case only: the slug is a URL segment, not free prose. */
const KEBAB_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Slug validation (#215): kebab-case, and never a fixed web route segment.
 * Next resolves static segments ahead of the dynamic `/<slug>` page route,
 * so a reserved slug would publish a page no URL can reach - reject it at
 * create/update time with the reason instead.
 */
const validateSlug: TextFieldSingleValidation = async (value) => {
  if (typeof value !== 'string' || value.length === 0) return 'A slug is required.';
  if (!KEBAB_SLUG.test(value)) {
    return 'Slugs are kebab-case URL segments - lowercase letters, digits and single dashes.';
  }
  if (isReservedWebSlug(value)) {
    return `"${value}" is a fixed route in the web app - pick another slug (the page would be unreachable).`;
  }
  return true;
};

/**
 * CMS-defined standalone pages (#215): each doc is one public page the web
 * app renders at `/<slug>`, exactly like the About page but without a
 * hardcoded route. Body sections are blocks (heading + prose) rather than
 * one rich-text field so rendering, seeding and live preview stay the same
 * simple shape as about-content/faq.
 */
export const Pages: CollectionConfig = {
  slug: 'pages',
  admin: { useAsTitle: 'title' },
  access: siteContentAccess,
  // Drafts power live preview; only published versions render publicly.
  versions: { drafts: true },
  fields: [
    {
      name: 'title',
      type: 'text',
      required: true,
    },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      validate: validateSlug,
      admin: {
        description:
          'Public URL segment: the page renders at /<slug>. Kebab-case; fixed routes are rejected.',
      },
    },
    {
      name: 'description',
      type: 'textarea',
      admin: { description: 'One-line summary for the page <meta> description.' },
    },
    {
      name: 'sections',
      type: 'blocks',
      required: true,
      labels: { singular: 'Section', plural: 'Sections' },
      blocks: [
        {
          slug: 'section',
          fields: [
            { name: 'heading', type: 'text' },
            { name: 'body', type: 'textarea', required: true },
          ],
        },
      ],
    },
  ],
};
