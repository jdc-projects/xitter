import { Alert, Container, Stack, Text, Title } from '@mantine/core';
import { requireSession } from '@/lib/auth/session';
import { PostComposer } from '@/components/post-composer';
import { PostListItem } from '@/components/post-list-item';
import { loadInterimFeed } from './load-feed';

export const metadata = { title: 'Feed' };

export default async function FeedPage() {
  const session = await requireSession('/feed');
  const feed = await loadInterimFeed(session).catch(() => null);

  return (
    <Container size="sm" py="xl">
      <Stack gap="md">
        <Title order={1}>Feed</Title>
        <PostComposer />

        {/* INTERIM (delete when #7's feed service lands): assembled web-side. */}
        <Text size="xs" c="dimmed" data-testid="feed-interim-note">
          Showing recent posts from accounts you follow{feed ? ` (${feed.followedCount})` : ''} and
          your own.
        </Text>

        {feed === null ? (
          <Alert color="red" data-testid="feed-error">
            The feed could not load right now. Try again shortly.
          </Alert>
        ) : feed.entries.length === 0 ? (
          <Text size="sm" c="dimmed" data-testid="feed-empty">
            No posts yet - follow some accounts or write the first one above.
          </Text>
        ) : (
          <Stack gap="md" data-testid="feed-timeline">
            {feed.entries.map(({ post, author }) => (
              <PostListItem
                key={post.id}
                post={post}
                author={author}
                canDelete={post.authorId === session.subject}
                username={author.username}
              />
            ))}
          </Stack>
        )}
      </Stack>
    </Container>
  );
}
