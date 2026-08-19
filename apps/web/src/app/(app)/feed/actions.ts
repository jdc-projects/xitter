'use server';

import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { loadFeed, type TimelineEntry } from './load-feed';

export interface FeedPageResult {
  entries: TimelineEntry[];
  nextCursor: string | null;
  error?: string;
}

/**
 * One feed page for the client timeline: `cursor` omitted walks page 1
 * (the new-items banner), set appends (Load more).
 */
export async function feedPageAction(cursor?: string): Promise<FeedPageResult> {
  const session = await getSession();
  if (!session) redirect('/login');

  try {
    const page = await loadFeed(session, cursor);
    return { entries: page.entries, nextCursor: page.nextCursor };
  } catch {
    return { entries: [], nextCursor: null, error: 'The feed could not load right now.' };
  }
}
