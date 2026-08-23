import type { Post } from '@xitter/api-contracts';
import type { PostCardItem } from '@/components/paginated-post-list';
import type { Session } from '@/lib/auth/session';
import { toPostCardItems } from '@/lib/posts/cards';
import { clientsForSession, profilesByAuthorIds, viewerStateByPostId } from '@/lib/posts/server';

/**
 * One chronological replies page for a thread (spec 03), mapped to card
 * rows. Used by the Load-more action; the detail page batches its page-1
 * fetch with the parent post instead.
 */
export async function loadRepliesPage(
  session: Session,
  postId: string,
  cursor?: string,
): Promise<{ items: PostCardItem[]; nextCursor: string | null }> {
  const { posts, social } = clientsForSession(session);
  const replies = await posts
    .getReplies(postId, cursor)
    .catch(() => ({ items: [] as Post[], nextCursor: null }));

  const authors = await profilesByAuthorIds(
    social,
    replies.items.map((reply) => reply.authorId),
  );
  const states = await viewerStateByPostId(
    posts,
    replies.items.map((reply) => reply.id),
  );
  return {
    items: toPostCardItems(replies.items, authors, states, session.subject),
    nextCursor: replies.nextCursor,
  };
}
