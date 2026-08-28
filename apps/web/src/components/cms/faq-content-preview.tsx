'use client';

import { useLivePreview } from '@payloadcms/live-preview-react';
import type { FaqEntry } from '@/lib/cms/content';
import { FaqList } from './faq-list';
import { cmsPopulateRequest, patchEntry } from './live-preview-utils';

/**
 * Live preview (/about?preview=<docId>): renders draft FAQ entries
 * server-side, then applies the doc Payload pushes as the admin edits.
 * About-section docs preview on the same page (#153) - a live doc without
 * FAQ fields is ignored rather than appended as an empty entry.
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
  const initialData = (match ?? { id: Number.parseInt(previewId, 10) || 0 }) as unknown as Record<
    string,
    unknown
  >;

  const { data } = useLivePreview({
    serverURL,
    depth: 0,
    initialData,
    requestHandler: cmsPopulateRequest(serverURL),
  });

  const live = data as Partial<FaqEntry> | null;
  const isFaqDoc = live?.question !== undefined || live?.answer !== undefined;
  return <FaqList entries={isFaqDoc ? patchEntry(entries, data) : entries} />;
}
