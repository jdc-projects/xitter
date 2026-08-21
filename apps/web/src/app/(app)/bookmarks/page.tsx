import { Alert, Container, Stack, Text, Title } from '@mantine/core';
import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth/session';
import { loadBookmarksPage } from './load-bookmarks';
import { BookmarksList } from './bookmarks-list';

export const metadata: Metadata = { title: 'Bookmarks' };

/**
 * The viewer's private bookmark list (#8, product 6.2): only the caller's
 * own bookmarks ever appear, newest bookmark first. Load more appends in
 * place on the shared cursor pattern (#41).
 */
export default async function BookmarksPage() {
  const session = await requireSession('/bookmarks');
  const page = await loadBookmarksPage(session);

  return (
    <Container size="sm" py="xl">
      <Stack gap="md">
        <Title order={1} size="h3" data-testid="bookmarks-title">
          Bookmarks
        </Title>
        <Text size="sm" c="dimmed">
          Only you can see your bookmarks.
        </Text>

        {page.items.length === 0 ? (
          <Text size="sm" c="dimmed" data-testid="bookmarks-empty">
            Nothing bookmarked yet - tap the bookmark icon on a post to save it here.
          </Text>
        ) : (
          <BookmarksList initialItems={page.items} initialCursor={page.nextCursor} />
        )}

        <Alert color="blue" variant="light" data-testid="bookmarks-privacy-note">
          Bookmarks are private to your account.
        </Alert>
      </Stack>
    </Container>
  );
}
