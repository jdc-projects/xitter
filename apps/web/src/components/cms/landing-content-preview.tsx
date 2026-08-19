'use client';

import { useLivePreview } from '@payloadcms/live-preview-react';
import type { LandingEntry } from '@/lib/cms/content';
import { LandingCopy } from './landing-copy';
import { cmsPopulateRequest, patchEntry } from './live-preview-utils';

/**
 * Live preview (/?preview=<docId>): renders the draft entries server-side,
 * then applies the doc Payload pushes over postMessage as the admin edits.
 * `serverURL` is the browser-facing CMS origin (postMessage source check).
 */
export function LandingContentPreview({
  entries,
  previewId,
  serverURL,
}: {
  entries: LandingEntry[];
  previewId: string;
  serverURL: string;
}) {
  const match = entries.find((entry) => String(entry.id ?? '') === previewId);
  const initialData = match ?? {
    id: Number.parseInt(previewId, 10) || 0,
    slug: '',
    title: '',
    intro: '',
  };

  const { data } = useLivePreview({
    serverURL,
    depth: 0,
    initialData: initialData as unknown as Record<string, unknown>,
    // Route Payload's population call to the CMS itself - the app shares the
    // origin but not Payload's /api paths.
    requestHandler: cmsPopulateRequest(serverURL),
  });

  return <LandingCopy entries={patchEntry(entries, data)} />;
}
