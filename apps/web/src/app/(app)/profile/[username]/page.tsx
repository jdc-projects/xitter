import { Anchor, Badge, Container, Divider, Group, Stack, Text, Title } from '@mantine/core';
import { UserAvatar } from '@xitter/ui';
import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth/session';
import { EditProfileForm } from './edit-profile-form';
import { ProfileActions } from './profile-actions';
import { loadProfileView, type ProfileTab } from './load-profile';

export const metadata: Metadata = { title: 'Profile' };

type SearchParams = Promise<{ tab?: string; cursor?: string }>;

const BADGE_COLOR: Record<string, string> = {
  'badge-follows-you': 'gray',
  'badge-blocked': 'red',
};

function ProfileList({
  items,
}: {
  items: { id: string; username: string; displayName: string }[];
}) {
  if (items.length === 0) {
    return (
      <Text size="sm" c="dimmed" data-testid="profile-list-empty">
        Nobody here yet.
      </Text>
    );
  }
  return (
    <Stack gap="xs" mt="sm">
      {items.map((p) => (
        <Group key={p.id} gap="sm">
          <UserAvatar username={p.username} displayName={p.displayName} size="sm" />
          <Anchor href={`/profile/${p.username}`} size="sm" data-testid="profile-list-item">
            <strong>{p.displayName}</strong> @{p.username}
          </Anchor>
        </Group>
      ))}
    </Stack>
  );
}

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

export default async function ProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ username: string }>;
  searchParams: SearchParams;
}) {
  const { username } = await params;
  const session = await requireSession(`/profile/${username}`);
  const { tab = 'posts', cursor } = await searchParams;

  const { view, profile, counts, listTab, list } = await loadProfileView(
    session,
    username,
    tab as ProfileTab,
    cursor,
  );

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
        // Posts land with the posts feature ticket; the profile owns the shell.
        <Text size="sm" c="dimmed" data-testid="profile-posts-placeholder">
          Posts appear here once the posts feature lands.
        </Text>
      ) : null}

      {listTab && list ? (
        <>
          <ProfileList items={list.items} />
          {list.nextCursor ? (
            <Anchor
              href={`/profile/${profile.username}?tab=${listTab}&cursor=${list.nextCursor}`}
              size="sm"
              mt="md"
              display="block"
              data-testid="load-more"
            >
              Load more
            </Anchor>
          ) : null}
        </>
      ) : null}
    </Container>
  );
}
