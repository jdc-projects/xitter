'use server';

import { redirect } from 'next/navigation';
import type { PostCardItem } from '@/components/paginated-post-list';
import type { CursorPage } from '@/components/use-cursor-pages';
import { getSession } from '@/lib/auth/session';
import { loadRepliesPage } from './load-replies';

/**
 * One more replies page for the thread (#41 append-in-place; #152: also the
 * per-node expansion fetch for the nested tree). Without a cursor it is
 * page 1 - the "Show N replies" reveal under a tree node.
 */
export async function repliesPageAction(
  postId: string,
  cursor?: string,
): Promise<CursorPage<PostCardItem>> {
  const session = await getSession();
  if (!session) redirect('/login');

  try {
    return await loadRepliesPage(session, postId, cursor);
  } catch {
    return { items: [], nextCursor: null, error: 'Replies could not load right now.' };
  }
}
