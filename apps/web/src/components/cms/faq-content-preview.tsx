'use client';

import type { FaqEntry } from '@/lib/cms/content';
import { FaqList } from './faq-list';
import { useLiveCollection } from './live-preview-collection';

/** Live preview (/about?preview=<docId>) for the CMS-managed FAQ entries. */
export function FaqContentPreview({
  entries,
  previewId,
  serverURL,
}: {
  entries: FaqEntry[];
  previewId: string;
  serverURL: string;
}) {
  // `question` marks a FAQ doc; About sections preview on the same page.
  const live = useLiveCollection(entries, previewId, serverURL, 'question');
  return <FaqList entries={live} />;
}
