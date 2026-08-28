'use client';

import { useLivePreview } from '@payloadcms/live-preview-react';
import type { AboutEntry } from '@/lib/cms/content';
import { AboutSections } from './about-sections';
import { cmsPopulateRequest, patchEntry } from './live-preview-utils';

/**
 * Live preview (/about?preview=<docId>): renders the draft About sections
 * server-side, then applies the doc Payload pushes over postMessage as the
 * admin edits. `serverURL` is the browser-facing CMS origin (postMessage
 * source check). FAQ docs preview on the same page - a live doc without
 * About fields is ignored rather than appended as an empty section.
 */
export function AboutContentPreview({
  entries,
  previewId,
  serverURL,
}: {
  entries: AboutEntry[];
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
    // Route Payload's population call to the CMS itself - the app shares the
    // origin but not Payload's /api paths.
    requestHandler: cmsPopulateRequest(serverURL),
  });

  const live = data as Partial<AboutEntry> | null;
  const isAboutDoc = live?.intro !== undefined || live?.title !== undefined;
  return <AboutSections entries={isAboutDoc ? patchEntry(entries, data) : entries} />;
}
