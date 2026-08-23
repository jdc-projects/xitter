import type { Post } from '@xitter/api-contracts';
import type { PostCardItem } from '@/components/paginated-post-list';

/** Minimal profile shape the card rows need (full Profile satisfies it). */
type AuthorProfile = { id: string; username: string; displayName: string };

/** Viewer-flag shape (full PostViewerState satisfies it). */
type ViewerFlags = { liked?: boolean; reposted?: boolean; bookmarked?: boolean };

/**
 * Post page → serialisable card rows for the client-side paginated lists
 * (#41): authors and viewer flags are hydrated server-side so the client
 * list never touches tokens (ADR 0002). `username` (the author's profile)
 * rides along so a card delete revalidates the profile it appears on.
 */
export function toPostCardItems(
  posts: Post[],
  authors: ReadonlyMap<string, AuthorProfile>,
  states: ReadonlyMap<string, ViewerFlags>,
  viewerId: string,
): PostCardItem[] {
  return posts.map((post) => {
    const author = authors.get(post.authorId);
    const row = author
      ? { id: author.id, username: author.username, displayName: author.displayName }
      : { id: post.authorId, username: 'unknown', displayName: 'Unknown' };
    return {
      post,
      author: row,
      viewer: states.get(post.id),
      canDelete: post.authorId === viewerId,
      username: row.username,
    };
  });
}
