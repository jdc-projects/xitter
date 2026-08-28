/**
 * Payload live-preview helpers shared by the About-section and FAQ preview
 * components (kept out of the component files so they stay component-only).
 */

/** Replace the matching entry with the live doc; append brand-new docs. */
function patchEntry<T extends { id?: number; slug: string }>(
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

/**
 * Patch entries with a live doc only when it belongs to this collection
 * (field-shape check). Both CMS collections preview on the About page
 * (#153): each preview component receives the other collection's docs too
 * and must ignore them rather than append empty entries.
 */
export function patchLiveIf<T extends { id?: number; slug: string }>(
  entries: T[],
  live: Record<string, unknown> | null | undefined,
  field: keyof T,
): T[] {
  if (!live || live[field as string] === undefined) return entries;
  return patchEntry(entries, live);
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
