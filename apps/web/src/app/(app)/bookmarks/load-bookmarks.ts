import { ApiError } from '@xitter/api-client';
import type { Post } from '@xitter/api-contracts';
import type { PostCardItem } from '@/components/paginated-post-list';
import type { Session } from '@/lib/auth/session';
import { toPostCardItems } from '@/lib/posts/cards';
import { clientsForSession, profilesByAuthorIds, viewerStateByPostId } from '@/lib/posts/server';

/**
 * The viewer's private bookmark list (#8, product 6.2), mapped to card rows:
 * only the caller's own bookmarks ever appear, newest bookmark first,
 * cursor-paginated. Shared by the page (SSR page 1) and the Load-more
 * action (#41).
 */
export async function loadBookmarksPage(
  session: Session,
  cursor?: string,
): Promise<{ items: PostCardItem[]; nextCursor: string | null }> {
  const { posts, social } = clientsForSession(session);

  let page: { items: Post[]; nextCursor: string | null };
  try {
    page = await posts.getBookmarks(cursor);
  } catch (error) {
    // Forged cursor: behave like an empty page rather than crashing.
    if (error instanceof ApiError && error.status === 400) {
      return { items: [], nextCursor: null };
    }
    throw error;
  }

  const authors = await profilesByAuthorIds(
    social,
    page.items.map((post) => post.authorId),
  );
  const states = await viewerStateByPostId(
    posts,
    page.items.map((post) => post.id),
  );
  return {
    items: toPostCardItems(page.items, authors, states, session.subject),
    nextCursor: page.nextCursor,
  };
}
