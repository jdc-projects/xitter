'use server';

import { redirect } from 'next/navigation';
import type { PostCardItem } from '@/components/paginated-post-list';
import type { CursorPage } from '@/components/use-cursor-pages';
import { getSession } from '@/lib/auth/session';
import { loadSearch } from './load-search';

/**
 * One more search-results page for the client list (#41: append in place).
 * A cold/broken index mid-scroll degrades to an inline error + retry, the
 * same honesty as the page-1 degraded state.
 */
export async function searchPageAction(
  query: string,
  cursor: string,
): Promise<CursorPage<PostCardItem>> {
  const session = await getSession();
  if (!session) redirect('/login');

  const page = await loadSearch(session, query, cursor);
  if (page.status === 'degraded') {
    return {
      items: [],
      nextCursor: null,
      error: 'Search is warming up - results are not available right now. Try again in a moment.',
    };
  }
  return {
    items: page.entries.map(({ post, author, viewer, replyToAuthor }) => ({
      post,
      author,
      viewer,
      ...(replyToAuthor ? { replyToAuthor } : {}),
      canDelete: post.authorId === session.subject,
    })),
    nextCursor: page.nextCursor,
  };
}
