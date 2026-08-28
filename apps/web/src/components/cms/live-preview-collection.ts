'use client';

import { useLivePreview } from '@payloadcms/live-preview-react';
import { cmsPopulateRequest, patchLiveIf } from './live-preview-utils';

/**
 * Live preview for one CMS collection (`/about?preview=<docId>`, #153):
 * renders the draft entries server-side, then applies the doc Payload
 * pushes over postMessage as the admin edits. `serverURL` is the
 * browser-facing CMS origin (postMessage source check), and the population
 * call is routed to the CMS itself - the app shares the origin but not
 * Payload's /api paths.
 *
 * Both content collections preview on the About page, so each consumer
 * names its collection's `field`: a live doc without it belongs to the
 * other collection and is ignored rather than appended as an empty entry.
 */
export function useLiveCollection<T extends { id?: number; slug: string }>(
  entries: T[],
  previewId: string,
  serverURL: string,
  field: keyof T,
): T[] {
  const match = entries.find((entry) => String(entry.id ?? '') === previewId);
  const initialData = (match ?? {
    id: Number.parseInt(previewId, 10) || 0,
  }) as unknown as Record<string, unknown>;

  const { data } = useLivePreview({
    serverURL,
    depth: 0,
    initialData,
    requestHandler: cmsPopulateRequest(serverURL),
  });

  return patchLiveIf(entries, data, field);
}
