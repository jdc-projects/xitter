'use server';

import { redirect } from 'next/navigation';
import type { PostCardItem } from '@/components/paginated-post-list';
import type { CursorPage } from '@/components/use-cursor-pages';
import { getSession } from '@/lib/auth/session';
import { loadBookmarksPage } from './load-bookmarks';

/** One more bookmarks page for the client list (#41: append in place). */
export async function bookmarksPageAction(cursor: string): Promise<CursorPage<PostCardItem>> {
  const session = await getSession();
  if (!session) redirect('/login');

  try {
    return await loadBookmarksPage(session, cursor);
  } catch {
    return { items: [], nextCursor: null, error: 'Bookmarks could not load right now.' };
  }
}
