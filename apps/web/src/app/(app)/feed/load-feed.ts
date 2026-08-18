import { FeedClient, localServiceUrls } from '@xitter/api-client';
import type { HydratedFeedItem, Post } from '@xitter/api-contracts';
import type { Session } from '@/lib/auth/session';

export interface TimelineEntry {
  post: Post;
  author: { id: string; username: string; displayName: string };
}

/** Page size for the web feed (server page 1 and Load more both use it). */
export const FEED_PAGE_SIZE = 20;

/** Feed page items → render entries (pure; the service pre-hydrates). */
export function toTimelineEntries(items: HydratedFeedItem[]): TimelineEntry[] {
  return items.map(({ post, author }) => ({
    post,
    author: { id: author.id, username: author.username, displayName: author.displayName },
  }));
}

/**
 * One materialised-feed page (#7): server-side joins (posts + social) come
 * back with the entries, newest first - the web no longer assembles the
 * timeline client-of-server side.
 */
export async function loadFeed(
  session: Session,
  cursor?: string,
): Promise<{ entries: TimelineEntry[]; nextCursor: string | null }> {
  const feed = new FeedClient({
    baseUrl: localServiceUrls().feed,
    token: session.accessToken,
  });
  const page = await feed.getFeed(cursor, FEED_PAGE_SIZE);
  return { entries: toTimelineEntries(page.items), nextCursor: page.nextCursor };
}
