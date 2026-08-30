import { Badge, Button, Container, Divider, Group, Stack, Text, Title } from '@mantine/core';
import { UserAvatar } from '@xitter/ui';
import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth/session';
import { toPostCardItems } from '@/lib/posts/cards';
import { DormantProfile } from './dormant-profile';
import { EditProfileForm } from './edit-profile-form';
import { ProfileActions } from './profile-actions';
import { ProfileTabLists } from './profile-tab-lists';
import { ProfileTabs } from './profile-tabs';
import { loadProfileView, type ProfileTab } from './load-profile';

export const metadata: Metadata = { title: 'Profile' };

type SearchParams = Promise<{ tab?: string }>;

const BADGE_COLOR: Record<string, string> = {
  'badge-follows-you': 'gray',
  'badge-blocked': 'red',
};

/**
 * Posts-tab empty state (#43): your own postless profile points at the
 * composer instead of dead-ending; anyone else's stays plain.
 */
function PostsTabEmpty({ isOwnProfile }: { isOwnProfile: boolean }) {
  if (!isOwnProfile) {
    return (
      <Text size="sm" c="dimmed" data-testid="profile-posts-empty">
        No posts yet.
      </Text>
    );
  }
  return (
    <Stack gap="xs" align="flex-start" data-testid="profile-posts-empty">
      <Text size="sm" c="dimmed">
        You have not posted yet - say something on the feed.
      </Text>
      <Button component="a" href="/feed" size="xs" variant="light">
        Go to the feed
      </Button>
    </Stack>
  );
}

/** Follow-graph empty state (#43): your own empty following list explains why. */
function PeopleTabEmpty({ isOwnFollowing }: { isOwnFollowing: boolean }) {
  return (
    <Text size="sm" c="dimmed" data-testid="profile-list-empty">
      {isOwnFollowing
        ? 'You are not following anyone yet - the feed only shows posts from accounts you follow.'
        : 'Nobody here yet.'}
    </Text>
  );
}

/**
 * Profile page (#4): identity header, relationship actions, and the active
 * tab's list. Load more appends in place on the shared cursor pattern (#41)
 * - the old `?cursor=` anchor walks scrolled back to the top.
 */
export default async function ProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ username: string }>;
  searchParams: SearchParams;
}) {
  const { username } = await params;
  const session = await requireSession(`/profile/${username}`);
  const { tab = 'posts' } = await searchParams;

  const data = await loadProfileView(session, username, tab as ProfileTab);
  // Demo account that has never logged in (#36): empty-profile shell, not
  // the generic 404.
  if (data.dormant) return <DormantProfile username={data.username} />;
  const { view, profile, counts, listTab, list, posts, viewerFlags } = data;

  // Card rows for the client-side lists (#41): hydrated server-side, page 1.
  const authorMap = new Map([[profile.id, profile]]);
  const postsProps =
    posts && posts.items.length > 0
      ? {
          items: toPostCardItems(posts.items, authorMap, viewerFlags, session.subject),
          nextCursor: posts.nextCursor,
        }
      : null;
  const peopleProps =
    list && list.items.length > 0
      ? {
          items: list.items.map((person) => ({
            id: person.id,
            username: person.username,
            displayName: person.displayName,
          })),
          nextCursor: list.nextCursor,
        }
      : null;

  return (
    <Container size="sm" py="xl">
      {/* Responsive stack (#151): the identity block is full-width below
        sm, so the actions always wrap onto their own left-aligned row under
        it; from sm the block is auto-width and shares one space-between row.
        One DOM node keeps every testid singular - e2e stays viewport-agnostic
        instead of duplicating hidden/visible copies. (Mantine 9's Group
        justify/wrap are not responsive style props, so the stacking rides on
        the responsive `w` style prop.) */}
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
        <Group gap="md" wrap="nowrap" w={{ base: '100%', sm: 'auto' }}>
          <UserAvatar
            username={profile.username}
            displayName={profile.displayName}
            size="lg"
            data-testid="profile-avatar"
          />
          <Stack gap={4} style={{ minWidth: 0 }}>
            <Title
              order={1}
              size="h2"
              data-testid="profile-display-name"
              // Long unbroken display names must wrap, not overflow (#151).
              style={{ overflowWrap: 'anywhere' }}
            >
              {profile.displayName}
            </Title>
            <Text size="sm" c="dimmed" data-testid="profile-username">
              @{profile.username}
            </Text>
          </Stack>
        </Group>
        {view.isOwnProfile ? (
          <EditProfileForm
            userId={profile.id}
            username={profile.username}
            displayName={profile.displayName}
            bio={profile.bio}
          />
        ) : (
          <ProfileActions
            userId={profile.id}
            username={profile.username}
            primaryAction={view.primaryAction}
            canBlock={view.canBlock}
            blocking={view.blocking}
          />
        )}
      </Group>

      <Group gap="xs" mt="sm">
        {view.badges.map((badge) => (
          <Badge
            key={badge.testId}
            color={BADGE_COLOR[badge.testId]}
            variant="light"
            data-testid={badge.testId}
          >
            {badge.label}
          </Badge>
        ))}
      </Group>

      <Text mt="sm" data-testid="profile-bio">
        {profile.bio ?? 'No bio yet.'}
      </Text>

      <Divider my="md" />

      <ProfileTabs active={tab} profile={profile} counts={counts} />

      {tab === 'posts' ? (
        postsProps ? (
          <ProfileTabLists
            username={profile.username}
            tab="posts"
            posts={postsProps}
            people={null}
          />
        ) : (
          <PostsTabEmpty isOwnProfile={view.isOwnProfile} />
        )
      ) : null}

      {listTab ? (
        peopleProps ? (
          <ProfileTabLists
            username={profile.username}
            tab={listTab}
            posts={null}
            people={peopleProps}
          />
        ) : (
          <PeopleTabEmpty isOwnFollowing={view.isOwnProfile && listTab === 'following'} />
        )
      ) : null}
    </Container>
  );
}
