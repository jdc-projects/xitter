'use client';

import { useLivePreview } from '@payloadcms/live-preview-react';
import type { PageEntry } from '@/lib/cms/content';
import { cmsPopulateRequest } from './live-preview-utils';
import { PageSections } from './page-sections';

/**
 * Live preview for a CMS-defined page (`/<slug>?preview=<docId>`, #215):
 * the server renders the current draft, then edits the admin makes arrive
 * over postMessage and replace the rendered doc wholesale. Unlike the
 * About page, only one collection previews on this URL, so no
 * field-shape check is needed - just a usable doc.
 */
/** The doc id the server rendered (draft docs may omit it in preview). */
function docId(page: PageEntry, previewId: string): number {
  return page.id ?? (Number.parseInt(previewId, 10) || 0);
}

/** Live edits arrive as postMessage payloads; anything else is ignored. */
function usableLiveDoc(data: unknown, fallback: PageEntry): PageEntry {
  return Array.isArray((data as PageEntry | null)?.sections) ? (data as PageEntry) : fallback;
}

export function PagePreview({
  page,
  previewId,
  serverURL,
}: {
  page: PageEntry;
  previewId: string;
  serverURL: string;
}) {
  const initialData = { ...page, id: docId(page, previewId) } as unknown as Record<string, unknown>;

  const { data } = useLivePreview({
    serverURL,
    depth: 0,
    initialData,
    requestHandler: cmsPopulateRequest(serverURL),
  });

  return <PageSections page={usableLiveDoc(data, page)} />;
}
