'use client';

import { useLivePreview } from '@payloadcms/live-preview-react';
import type { FaqEntry } from '@/lib/cms/content';
import { FaqList } from './faq-list';
import { cmsPopulateRequest, patchEntry } from './live-preview-utils';

/**
 * Live preview (/about?preview=<docId>): renders draft FAQ entries
 * server-side, then applies the doc Payload pushes as the admin edits.
 */
export function FaqContentPreview({
  entries,
  previewId,
  serverURL,
}: {
  entries: FaqEntry[];
  previewId: string;
  serverURL: string;
}) {
  const match = entries.find((entry) => String(entry.id ?? '') === previewId);
  const initialData = match ?? {
    id: Number.parseInt(previewId, 10) || 0,
    slug: '',
    question: '',
    answer: '',
  };

  const { data } = useLivePreview({
    serverURL,
    depth: 0,
    initialData: initialData as unknown as Record<string, unknown>,
    requestHandler: cmsPopulateRequest(serverURL),
  });

  return <FaqList entries={patchEntry(entries, data)} />;
}
