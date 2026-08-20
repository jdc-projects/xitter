import { PostsClient, SearchClient, localServiceUrls } from '@xitter/api-client';
import type { Session } from '@/lib/auth/session';
import { toTimelineEntries, type TimelineEntry } from '../feed/load-feed';

/** Page size for search results (server page 1 and Load more both use it). */
const SEARCH_PAGE_SIZE = 20;

export interface SearchResultPage {
  /** 'degraded' = the search backend is unreachable; entries is then empty. */
  status: 'ok' | 'degraded';
  entries: TimelineEntry[];
  nextCursor: string | null;
}

/**
 * One search results page (#9): the search service hydrates post + author
 * server-side (same shape as feed items), so the mapping is shared. A 5xx
 * (or network failure) degrades the page instead of throwing - a cold or
 * broken index must never 500 the results screen.
 */
export async function loadSearch(
  session: Session,
  q: string,
  cursor?: string,
): Promise<SearchResultPage> {
  const search = new SearchClient({
    baseUrl: localServiceUrls().search,
    token: session.accessToken,
  });
  const posts = new PostsClient({ baseUrl: localServiceUrls().posts, token: session.accessToken });
  try {
    const page = await search.searchPosts(q, cursor, SEARCH_PAGE_SIZE);
    // Best-effort viewer flags, same as the feed loader: without them the
    // cards render un-filled but usable.
    const flags = await posts
      .getViewerState(page.items.map((item) => item.post.id))
      .then(({ items }) => new Map(items.map((s) => [s.postId, s])))
      .catch(() => new Map<string, { liked: boolean; reposted: boolean; bookmarked: boolean }>());
    return {
      status: 'ok',
      entries: toTimelineEntries(page.items, flags),
      nextCursor: page.nextCursor,
    };
  } catch {
    return { status: 'degraded', entries: [], nextCursor: null };
  }
}
