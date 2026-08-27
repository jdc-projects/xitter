import { FeedClient, PostsClient, localServiceUrls } from '@xitter/api-client';
import type { HydratedFeedItem, Post } from '@xitter/api-contracts';
import type { Session } from '@/lib/auth/session';

export interface TimelineEntry {
  post: Post;
  author: { id: string; username: string; displayName: string };
  /** Repost entries (#8): the reposter renders an attribution line. */
  repostedBy?: { id: string; username: string; displayName: string };
  /** Replies (#147): the reply-target author renders a "Replying to @x" line. */
  replyToAuthor?: { id: string; username: string; displayName: string };
  /** #148a: client-side optimistic entry - not yet confirmed by a fetch. */
  pending?: boolean;
  /** The viewer's like/repost/bookmark flags for the post (best-effort). */
  viewer: { liked: boolean; reposted: boolean; bookmarked: boolean };
}

/** Page size for the web feed (server page 1 and Load more both use it). */
const FEED_PAGE_SIZE = 20;

/** Feed page items → render entries (pure; the service pre-hydrates). */
export function toTimelineEntries(
  items: HydratedFeedItem[],
  flags: ReadonlyMap<string, { liked: boolean; reposted: boolean; bookmarked: boolean }>,
): TimelineEntry[] {
  return items.map(({ post, author, repostedBy, replyToAuthor }) => ({
    post,
    author: { id: author.id, username: author.username, displayName: author.displayName },
    ...(repostedBy
      ? {
          repostedBy: {
            id: repostedBy.id,
            username: repostedBy.username,
            displayName: repostedBy.displayName,
          },
        }
      : {}),
    ...(replyToAuthor
      ? {
          replyToAuthor: {
            id: replyToAuthor.id,
            username: replyToAuthor.username,
            displayName: replyToAuthor.displayName,
          },
        }
      : {}),
    viewer: flags.get(post.id) ?? { liked: false, reposted: false, bookmarked: false },
  }));
}

/**
 * One materialised-feed page (#7): server-side joins (posts + social) come
 * back with the entries, newest first - the web no longer assembles the
 * timeline client-of-server side. Viewer interaction flags ride along so
 * PostCards render filled states (#8).
 */
export async function loadFeed(
  session: Session,
  cursor?: string,
): Promise<{ entries: TimelineEntry[]; nextCursor: string | null }> {
  const urls = localServiceUrls();
  const feed = new FeedClient({ baseUrl: urls.feed, token: session.accessToken });
  const posts = new PostsClient({ baseUrl: urls.posts, token: session.accessToken });

  const page = await feed.getFeed(cursor, FEED_PAGE_SIZE);
  // Best-effort: without flags the cards render un-filled but usable.
  const flags = await posts
    .getViewerState(page.items.map((item) => item.post.id))
    .then(({ items }) => new Map(items.map((s) => [s.postId, s])))
    .catch(() => new Map<string, { liked: boolean; reposted: boolean; bookmarked: boolean }>());

  return { entries: toTimelineEntries(page.items, flags), nextCursor: page.nextCursor };
}
