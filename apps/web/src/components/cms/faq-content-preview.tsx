'use client';

import { useLivePreview } from '@payloadcms/live-preview-react';
import { useMemo } from 'react';
import type { FaqEntry } from '@/lib/cms/content';
import { FaqList } from './faq-list';
import { cmsPopulateRequest, patchEntry } from './landing-content-preview';

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
  const initialData = useMemo(() => {
    const match = entries.find((entry) => String(entry.id ?? '') === previewId);
    return (
      match ?? {
        id: Number.parseInt(previewId, 10) || 0,
        slug: '',
        question: '',
        answer: '',
      }
    ) as unknown as Record<string, unknown>;
  }, [entries, previewId]);

  const { data } = useLivePreview({
    serverURL,
    depth: 0,
    initialData,
    requestHandler: cmsPopulateRequest(serverURL),
  });

  return <FaqList entries={patchEntry(entries, data)} />;
}
