import { Anchor, Badge, Container, Divider, Group, Stack, Tabs, Text, Title } from '@mantine/core';
import { SocialClient, localServiceUrls, ApiError } from '@xitter/api-client';
import { UserAvatar } from '@xitter/ui';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth/session';
import { profileViewState } from '@/lib/social/view-model';
import { EditProfileForm } from './edit-profile-form';
import { ProfileActions } from './profile-actions';

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

  // Server-side fetch with the session token (ADR 0002).
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
  const view = profileViewState(session.subject, withCounts, relationship);

  const listTab = tab === 'following' || tab === 'followers' ? tab : null;
  const list = listTab
    ? listTab === 'following'
      ? await social.getFollowing(profile.id, cursor)
      : await social.getFollowers(profile.id, cursor)
    : null;

  return (
    <Container size="sm" py="xl">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Group gap="md" wrap="nowrap">
          <UserAvatar
            username={profile.username}
            displayName={withCounts.displayName}
            size="lg"
            data-testid="profile-avatar"
          />
          <Stack gap={4}>
            <Title order={1} size="h2" data-testid="profile-display-name">
              {withCounts.displayName}
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
            displayName={withCounts.displayName}
            bio={withCounts.bio}
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
        {withCounts.bio ?? 'No bio yet.'}
      </Text>

      <Divider my="md" />

      <Tabs value={tab} data-testid="profile-tabs">
        <Tabs.List>
          <Tabs.Tab
            value="posts"
            renderRoot={(props) => <a {...props} href={`/profile/${profile.username}`} />}
          >
            Posts
          </Tabs.Tab>
          <Tabs.Tab
            value="following"
            renderRoot={(props) => (
              <a {...props} href={`/profile/${profile.username}?tab=following`} />
            )}
            data-testid="tab-following"
          >
            Following {withCounts.counts.following}
          </Tabs.Tab>
          <Tabs.Tab
            value="followers"
            renderRoot={(props) => (
              <a {...props} href={`/profile/${profile.username}?tab=followers`} />
            )}
            data-testid="tab-followers"
          >
            Followers {withCounts.counts.followers}
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="posts" pt="md">
          {/* Posts land with the posts feature ticket; the profile owns the shell. */}
          <Text size="sm" c="dimmed" data-testid="profile-posts-placeholder">
            Posts appear here once the posts feature lands.
          </Text>
        </Tabs.Panel>

        <Tabs.Panel value="following" pt="md">
          {listTab === 'following' && list ? (
            <>
              <ProfileList items={list.items} />
              {list.nextCursor ? (
                <Anchor
                  href={`/profile/${profile.username}?tab=following&cursor=${list.nextCursor}`}
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
        </Tabs.Panel>

        <Tabs.Panel value="followers" pt="md">
          {listTab === 'followers' && list ? (
            <>
              <ProfileList items={list.items} />
              {list.nextCursor ? (
                <Anchor
                  href={`/profile/${profile.username}?tab=followers&cursor=${list.nextCursor}`}
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
        </Tabs.Panel>
      </Tabs>
    </Container>
  );
}
