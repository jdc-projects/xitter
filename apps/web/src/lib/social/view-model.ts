import type { ProfileWithCounts, Relationship } from '@xitter/api-contracts';

/** Badge shown on a profile header (product spec 7.5). */
export interface ProfileBadge {
  testId: string;
  label: string;
}

export interface ProfileViewState {
  isOwnProfile: boolean;
  badges: ProfileBadge[];
  /**
   * Primary header action. `null` renders no button: own profiles edit via
   * the edit dialog instead, and a viewer who blocked someone cannot follow
   * them (the block replaces the relationship).
   */
  primaryAction: 'follow' | 'unfollow' | null;
  /** Block toggle; hidden on your own profile. */
  canBlock: boolean;
  blocking: boolean;
}

/**
 * Pure mapping from the social API's relationship flags to the profile
 * header's UI state. Kept free of React so the rules (spec 7.3/7.5/8.2) are
 * unit-testable: badges come from the target's perspective on the viewer
 * ("Follows you"), blocks in either direction render a "Blocked" badge, and
 * the viewer cannot follow anyone they have blocked.
 */
export function profileViewState(
  viewerId: string,
  profile: Pick<ProfileWithCounts, 'id'>,
  relationship: Relationship,
): ProfileViewState {
  const isOwnProfile = viewerId === profile.id;
  const badges: ProfileBadge[] = [];

  if (!isOwnProfile && relationship.followedBy) {
    badges.push({ testId: 'badge-follows-you', label: 'Follows you' });
  }
  if (!isOwnProfile && (relationship.blocking || relationship.blockedBy)) {
    badges.push({ testId: 'badge-blocked', label: 'Blocked' });
  }

  let primaryAction: ProfileViewState['primaryAction'] = null;
  if (!isOwnProfile && !relationship.blocking) {
    primaryAction = relationship.following ? 'unfollow' : 'follow';
  }

  return {
    isOwnProfile,
    badges,
    primaryAction,
    canBlock: !isOwnProfile,
    blocking: relationship.blocking,
  };
}
