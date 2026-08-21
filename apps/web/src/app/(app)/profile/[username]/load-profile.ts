import { notFound } from 'next/navigation';
import { ApiError, PostsClient, SocialClient, localServiceUrls } from '@xitter/api-client';
import type { Post } from '@xitter/api-contracts';
import type { PersonItem } from '@/components/paginated-people-list';
import type { PostCardItem } from '@/components/paginated-post-list';
import { profileViewState } from '@/lib/social/view-model';
import type { Session } from '@/lib/auth/session';
import { toPostCardItems } from '@/lib/posts/cards';
import { viewerStateByPostId } from '@/lib/posts/server';

export type ProfileTab = 'posts' | 'following' | 'followers';

export interface ProfileViewData {
  view: ReturnType<typeof profileViewState>;
  profile: { id: string; username: string; displayName: string; bio: string | null };
  counts: { following: number; followers: number };
  listTab: 'following' | 'followers' | null;
  list: {
    items: Awaited<ReturnType<SocialClient['getFollowing']>>['items'];
    nextCursor: string | null;
  } | null;
  /** Posts tab: the author's posts page (own-profile delete affordance). */
  posts: { items: Post[]; nextCursor: string | null } | null;
  /** Posts tab: viewer interaction flags per post id (#8, best-effort). */
  viewerFlags: Map<string, { liked: boolean; reposted: boolean; bookmarked: boolean }>;
}

/**
 * One more posts page for the profile tab's client list (#41). Throws on a
 * missing profile - the Load-more action maps that to an inline error
 * (the page itself renders the 404).
 */
export async function loadProfilePostsPage(
  session: Session,
  username: string,
  cursor?: string,
): Promise<{ items: PostCardItem[]; nextCursor: string | null }> {
  const social = new SocialClient({
    baseUrl: localServiceUrls().social,
    token: session.accessToken,
  });
  const profile = await social.getProfileByUsername(username);
  const postsClient = new PostsClient({
    baseUrl: localServiceUrls().posts,
    token: session.accessToken,
  });
  const posts = await postsClient.getUserPosts(profile.id, cursor);
  const viewerFlags = await viewerStateByPostId(
    postsClient,
    posts.items.map((post) => post.id),
  );
  return {
    items: toPostCardItems(posts.items, new Map([[profile.id, profile]]), viewerFlags, session.subject),
    nextCursor: posts.nextCursor,
  };
}

/** One more following/followers page for the profile tab's client list (#41). */
export async function loadProfilePeoplePage(
  session: Session,
  username: string,
  tab: 'following' | 'followers',
  cursor?: string,
): Promise<{ items: PersonItem[]; nextCursor: string | null }> {
  const social = new SocialClient({
    baseUrl: localServiceUrls().social,
    token: session.accessToken,
  });
  const profile = await social.getProfileByUsername(username);
  const page =
    tab === 'following'
      ? await social.getFollowing(profile.id, cursor)
      : await social.getFollowers(profile.id, cursor);
  return {
    items: page.items.map((person) => ({
      id: person.id,
      username: person.username,
      displayName: person.displayName,
    })),
    nextCursor: page.nextCursor,
  };
}

/**
 * All profile-page data fetching in one place so the page component is
 * layout-only: profile lookup (404 -> notFound), counts + relationship in
 * parallel, and the follow-list or posts page for the active tab.
 */
export async function loadProfileView(
  session: Session,
  username: string,
  tab: ProfileTab,
  cursor?: string,
): Promise<ProfileViewData> {
  const social = new SocialClient({
    baseUrl: localServiceUrls().social,
    token: session.accessToken,
  });

  let profile;
  try {
    profile = await social.getProfileByUsername(username);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const [withCounts, relationship] = await Promise.all([
    social.getProfile(profile.id),
    social.getRelationship(profile.id),
  ]);

  const listTab = tab === 'following' || tab === 'followers' ? tab : null;
  const list = !listTab
    ? null
    : listTab === 'following'
      ? await social.getFollowing(profile.id, cursor)
      : await social.getFollowers(profile.id, cursor);

  // Posts tab: author timelines live in the posts service (spec 03); the
  // author for every card is the profile being viewed.
  const postsClient = new PostsClient({
    baseUrl: localServiceUrls().posts,
    token: session.accessToken,
  });
  const posts = tab === 'posts' ? await postsClient.getUserPosts(profile.id, cursor) : null;
  const viewerFlags = posts
    ? await viewerStateByPostId(
        postsClient,
        posts.items.map((post) => post.id),
      )
    : new Map<string, { liked: boolean; reposted: boolean; bookmarked: boolean }>();

  return {
    view: profileViewState(session.subject, withCounts, relationship),
    profile: {
      id: profile.id,
      username: profile.username,
      displayName: withCounts.displayName,
      bio: withCounts.bio,
    },
    counts: withCounts.counts,
    listTab,
    list,
    posts,
    viewerFlags,
  };
}
