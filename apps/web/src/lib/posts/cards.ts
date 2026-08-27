import type { Post, ThreadNode } from '@xitter/api-contracts';
import type { PostCardItem } from '@/components/paginated-post-list';
import type { ThreadNodeItem } from '@/app/(app)/post/[postId]/thread-tree';

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

/** Every post in a thread tree, depth-first (hydration input for the page). */
export function threadTreePosts(nodes: ThreadNode[]): Post[] {
  return nodes.flatMap((node) => [node.post, ...threadTreePosts(node.children)]);
}

/**
 * Thread nodes → serialisable nested rows for the client tree (#152): the
 * same author/viewer hydration as `toPostCardItems`, subtree preserved.
 */
export function toThreadItems(
  nodes: ThreadNode[],
  authors: ReadonlyMap<string, AuthorProfile>,
  states: ReadonlyMap<string, ViewerFlags>,
  viewerId: string,
): ThreadNodeItem[] {
  return nodes.map((node) => ({
    ...toPostCardItems([node.post], authors, states, viewerId)[0]!,
    children: toThreadItems(node.children, authors, states, viewerId),
    childrenTruncated: node.childrenTruncated,
  }));
}

/**
 * Flat /replies card rows → leaf tree nodes for client-side expansion
 * (#152): the endpoint has no nesting, so children start empty and the
 * truncation flag follows the post's direct-reply counts (drives the next
 * "show"/"show this thread" affordance under the fetched node).
 */
export function leafNodesFromItems(items: PostCardItem[]): ThreadNodeItem[] {
  return items.map((item) => ({
    ...item,
    children: [],
    childrenTruncated: item.post.counts.replies > 0,
  }));
}
