'use client';

import { useState } from 'react';

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  error?: string;
}

/**
 * Cursor pagination state machine shared by every append-in-place list
 * (the feed's Load-more pattern, standardised across surfaces - #41):
 * page 1 arrives server-rendered, appends fetch client-side, and a server
 * re-render (a delete revalidating the page) resets to the fresh page 1
 * during render - the same reset the feed applies on revalidation.
 */
export function useCursorPages<T>(
  initialItems: T[],
  initialCursor: string | null,
  fetchPage: (cursor: string) => Promise<CursorPage<T>>,
) {
  const [pages, setPages] = useState<T[][]>([initialItems]);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Server revalidation re-renders page 1 - sync the reset during render
  // (same pattern as the feed's useFeedPages and the composer's drafts).
  const [synced, setSynced] = useState(initialItems);
  if (initialItems !== synced) {
    setSynced(initialItems);
    setPages([initialItems]);
    setCursor(initialCursor);
  }

  async function loadMore() {
    if (loading || !cursor) return;
    setLoading(true);
    setError(null);
    const page = await fetchPage(cursor);
    if (page.error) {
      setError(page.error);
    } else {
      setPages((current) => [...current, page.items]);
      setCursor(page.nextCursor);
    }
    setLoading(false);
  }

  return { items: pages.flat(), cursor, loading, error, loadMore };
}
