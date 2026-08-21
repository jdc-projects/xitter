import { Alert, Button, Container, Stack, Title } from '@mantine/core';
import { requireSession } from '@/lib/auth/session';
import { PostComposer } from '@/components/post-composer';
import { RetryRefreshButton } from '@/components/retry-refresh-button';
import { FeedView } from './feed-view';
import { loadFeed } from './load-feed';

export const metadata = { title: 'Feed' };

export default async function FeedPage() {
  const session = await requireSession('/feed');
  const initial = await loadFeed(session).catch(() => null);

  return (
    <Container size="sm" py="xl">
      <Stack gap="md">
        <Title order={1}>Feed</Title>
        <PostComposer />

        {initial === null ? (
          <Alert color="red" data-testid="feed-error">
            <Group justify="space-between" gap="sm">
              <span>The feed could not load right now. Try again shortly.</span>
              <RetryRefreshButton />
            </Group>
          </Alert>
        ) : (
          <FeedView
            initialEntries={initial.entries}
            initialCursor={initial.nextCursor}
            viewerId={session.subject}
          />
        )}
      </Stack>
    </Container>
  );
}
