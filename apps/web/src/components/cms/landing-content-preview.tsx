'use client';

import { useLivePreview } from '@payloadcms/live-preview-react';
import { useMemo } from 'react';
import type { LandingEntry } from '@/lib/cms/content';
import { LandingCopy } from './landing-copy';

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
  const initialData = useMemo(() => {
    const match = entries.find((entry) => String(entry.id ?? '') === previewId);
    return (match ?? { id: Number.parseInt(previewId, 10) || 0, slug: '', title: '', intro: '' }) as unknown as Record<
      string,
      unknown
    >;
  }, [entries, previewId]);

  const { data } = useLivePreview({
    serverURL,
    depth: 0,
    initialData,
    // Route Payload's population call to the CMS itself - the app shares the
    // origin but not Payload's /api paths.
    requestHandler: cmsPopulateRequest(serverURL),
  });

  return <LandingCopy entries={patchEntry(entries, data)} />;
}

/** Replace the matching entry with the live doc; append brand-new docs. */
export function patchEntry<T extends { id?: number; slug: string }>(
  entries: T[],
  live: Record<string, unknown>,
): T[] {
  const liveDoc = live as Partial<T> & { id?: number; slug?: string };
  const index = entries.findIndex(
    (entry) =>
      (liveDoc.id !== undefined && entry.id === liveDoc.id) ||
      (liveDoc.slug !== undefined && entry.slug === liveDoc.slug),
  );
  if (index === -1) {
    return liveDoc.slug || liveDoc.id !== undefined ? [...entries, liveDoc as T] : entries;
  }
  const next = entries.slice();
  next[index] = { ...entries[index]!, ...liveDoc };
  return next;
}

/** Payload live-preview population call, aimed at the CMS's /api routes. */
export function cmsPopulateRequest(serverURL: string) {
  return async ({
    apiPath,
    data,
    endpoint,
  }: {
    apiPath?: string;
    data: unknown;
    endpoint: string;
  }) =>
    fetch(`${serverURL}/cms${apiPath ?? '/api'}/${endpoint}`, {
      body: JSON.stringify(data),
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Payload-HTTP-Method-Override': 'GET',
      },
      method: 'POST',
    });
}
