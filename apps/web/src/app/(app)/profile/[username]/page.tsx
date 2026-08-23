import { Anchor, Badge, Container, Divider, Group, Stack, Text, Title } from '@mantine/core';
import { UserAvatar } from '@xitter/ui';
import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth/session';
import { toPostCardItems } from '@/lib/posts/cards';
import { EditProfileForm } from './edit-profile-form';
import { ProfileActions } from './profile-actions';
import { ProfileTabLists } from './profile-tab-lists';
import { loadProfileView, type ProfileTab } from './load-profile';

export const metadata: Metadata = { title: 'Profile' };

type SearchParams = Promise<{ tab?: string }>;

const BADGE_COLOR: Record<string, string> = {
  'badge-follows-you': 'gray',
  'badge-blocked': 'red',
};

function ProfileTabs({
  active,
  profile,
  counts,
}: {
  active: string;
  profile: { username: string };
  counts: { following: number; followers: number };
}) {
  const tabs = [
    { value: 'posts', label: 'Posts', href: `/profile/${profile.username}` },
    {
      value: 'following',
      label: `Following ${counts.following}`,
      href: `/profile/${profile.username}?tab=following`,
    },
    {
      value: 'followers',
      label: `Followers ${counts.followers}`,
      href: `/profile/${profile.username}?tab=followers`,
    },
  ];
  return (
    <Group gap={0} mb="md" data-testid="profile-tabs">
      {tabs.map((t) => (
        <Anchor
          key={t.value}
          href={t.href}
          unstyled
          px="sm"
          py="xs"
          data-testid={`tab-${t.value}`}
          style={{
            fontWeight: t.value === active ? 600 : 400,
            textDecoration: t.value === active ? 'underline' : 'none',
            textUnderlineOffset: 6,
          }}
          aria-current={t.value === active ? 'page' : undefined}
        >
          {t.label}
        </Anchor>
      ))}
    </Group>
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

  const { view, profile, counts, listTab, list, posts, viewerFlags } = await loadProfileView(
    session,
    username,
    tab as ProfileTab,
  );

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
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Group gap="md" wrap="nowrap">
          <UserAvatar
            username={profile.username}
            displayName={profile.displayName}
            size="lg"
            data-testid="profile-avatar"
          />
          <Stack gap={4}>
            <Title order={1} size="h2" data-testid="profile-display-name">
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
          <Text size="sm" c="dimmed" data-testid="profile-posts-empty">
            No posts yet.
          </Text>
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
          <Text size="sm" c="dimmed" data-testid="profile-list-empty">
            Nobody here yet.
          </Text>
        )
      ) : null}
    </Container>
  );
}
