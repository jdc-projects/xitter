import type { Post, Profile } from '@xitter/api-contracts';
import type { Session } from '@/lib/auth/session';
import { clientsForSession } from '@/lib/posts/server';

export interface TimelineEntry {
  post: Post;
  author: { id: string; username: string; displayName: string };
}

export interface InterimFeed {
  entries: TimelineEntry[];
  followedCount: number;
}

/** Pure merge: newest-first across authors, 20-item window, known authors only. */
export function mergeFeedEntries(
  pages: { items: Post[] }[],
  authorById: Map<string, Profile>,
): TimelineEntry[] {
  const entries: TimelineEntry[] = pages.flatMap((page) =>
    page.items
      .filter((post) => authorById.has(post.authorId))
      .map((post) => {
        const author = authorById.get(post.authorId)!;
        return {
          post,
          author: { id: author.id, username: author.username, displayName: author.displayName },
        };
      }),
  );
  entries.sort((a, b) => b.post.createdAt.localeCompare(a.post.createdAt));
  return entries.slice(0, 20);
}

/**
 * INTERIM (delete when #7 lands): the web assembles "posts from people you
 * follow + your own" by calling social's following list then posts per-user,
 * merging newest-first. The materialised feed service replaces this - no
 * pagination, fixed window, best-effort per-author.
 */
export async function loadInterimFeed(session: Session): Promise<InterimFeed> {
  const { posts, social } = clientsForSession(session);

  const [following, ownProfile] = await Promise.all([
    social.getFollowing(session.subject),
    social.getProfile(session.subject).catch(() => null),
  ]);

  const authorById = new Map<string, Profile>(following.items.map((p) => [p.id, p]));
  if (ownProfile) authorById.set(session.subject, ownProfile);

  const authorIds = [session.subject, ...following.items.map((p) => p.id)];
  const pages = await Promise.all(
    authorIds.map((id) => posts.getUserPosts(id).catch(() => ({ items: [], nextCursor: null }))),
  );

  return { entries: mergeFeedEntries(pages, authorById), followedCount: following.items.length };
}
