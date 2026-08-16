import { Container, Stack, Text, Title } from '@mantine/core';
import { requireSession } from '@/lib/auth/session';

export const metadata = { title: 'Feed' };

export default async function FeedPage() {
  const session = await requireSession('/feed');
  return (
    <Container size="sm" py="xl">
      <Stack gap="md">
        <Title order={1}>Feed</Title>
        {/* Feed loads posts from the feed API for the accounts you follow. */}
        <Text size="sm" c="dimmed" data-testid="feed-placeholder">
          Feed placeholder - posts from accounts you follow appear here.
        </Text>
      </Stack>
    </Container>
  );
}
