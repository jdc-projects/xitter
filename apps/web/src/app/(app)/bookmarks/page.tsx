import { Alert, Anchor, Container, Stack, Text, Title } from '@mantine/core';
import type { Metadata } from 'next';
import type { Post } from '@xitter/api-contracts';
import { ApiError } from '@xitter/api-client';
import { requireSession } from '@/lib/auth/session';
import { PostListItem } from '@/components/post-list-item';
import { clientsForSession, profilesByAuthorIds, viewerStateByPostId } from '@/lib/posts/server';

export const metadata: Metadata = { title: 'Bookmarks' };

type SearchParams = Promise<{ cursor?: string }>;

/**
 * The viewer's private bookmark list (#8, product 6.2): only the caller's
 * own bookmarks ever appear, newest bookmark first, cursor-paginated.
 * PostCard authors hydrate through social like every other list.
 */
export default async function BookmarksPage({ searchParams }: { searchParams: SearchParams }) {
  const { cursor } = await searchParams;
  const session = await requireSession('/bookmarks');
  const { posts, social } = clientsForSession(session);

  let page: { items: Post[]; nextCursor: string | null };
  try {
    page = await posts.getBookmarks(cursor);
  } catch (error) {
    if (error instanceof ApiError && error.status === 400) {
      // Forged cursor: behave like an empty page rather than crashing.
      page = { items: [], nextCursor: null };
    } else {
      throw error;
    }
  }

  const authors = await profilesByAuthorIds(
    social,
    page.items.map((post) => post.authorId),
  );
  const states = await viewerStateByPostId(
    posts,
    page.items.map((post) => post.id),
  );

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
          <>
            <Stack gap="md" data-testid="bookmarks-list">
              {page.items.map((post) => {
                const author = authors.get(post.authorId);
                return (
                  <PostListItem
                    key={post.id}
                    post={post}
                    author={
                      author
                        ? {
                            id: author.id,
                            username: author.username,
                            displayName: author.displayName,
                          }
                        : { id: post.authorId, username: 'unknown', displayName: 'Unknown' }
                    }
                    viewer={states.get(post.id)}
                    canDelete={post.authorId === session.subject}
                  />
                );
              })}
            </Stack>
            {page.nextCursor ? (
              <Anchor
                href={`/bookmarks?cursor=${page.nextCursor}`}
                size="sm"
                data-testid="load-more"
              >
                Load more
              </Anchor>
            ) : null}
          </>
        )}

        <Alert color="blue" variant="light" data-testid="bookmarks-privacy-note">
          Bookmarks are private to your account.
        </Alert>
      </Stack>
    </Container>
  );
}
