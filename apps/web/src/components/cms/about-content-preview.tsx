'use client';

import type { AboutEntry } from '@/lib/cms/content';
import { AboutSections } from './about-sections';
import { useLiveCollection } from './live-preview-collection';

/** Live preview (/about?preview=<docId>) for the About intro sections. */
export function AboutContentPreview({
  entries,
  previewId,
  serverURL,
}: {
  entries: AboutEntry[];
  previewId: string;
  serverURL: string;
}) {
  // `intro` marks an About-section doc; FAQ docs preview on the same page.
  const live = useLiveCollection(entries, previewId, serverURL, 'intro');
  return <AboutSections entries={live} />;
}
