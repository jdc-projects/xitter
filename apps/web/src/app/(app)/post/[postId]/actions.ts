'use server';

import { redirect } from 'next/navigation';
import type { PostCardItem } from '@/components/paginated-post-list';
import type { CursorPage } from '@/components/use-cursor-pages';
import { getSession } from '@/lib/auth/session';
import { loadRepliesPage } from './load-replies';

/** One more replies page for the client thread (#41: append in place). */
export async function repliesPageAction(
  postId: string,
  cursor: string,
): Promise<CursorPage<PostCardItem>> {
  const session = await getSession();
  if (!session) redirect('/login');

  try {
    return await loadRepliesPage(session, postId, cursor);
  } catch {
    return { items: [], nextCursor: null, error: 'Replies could not load right now.' };
  }
}
