import { notFound } from 'next/navigation';
import { ApiError, SocialClient, localServiceUrls } from '@xitter/api-client';
import { profileViewState } from '@/lib/social/view-model';
import type { Session } from '@/lib/auth/session';

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
}

/**
 * All profile-page data fetching in one place so the page component is
 * layout-only: profile lookup (404 -> notFound), counts + relationship in
 * parallel, and the follow-list for the active tab.
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
  };
}
