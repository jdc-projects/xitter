import { Alert, Anchor, Box, Container, Stack, Text, Title } from '@mantine/core';
import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth/session';
import { PostListItem } from '@/components/post-list-item';
import { SearchBox } from '@/components/search-box';
import { loadSearch } from './load-search';

type SearchParams = Promise<{ q?: string; cursor?: string }>;

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const { q } = await searchParams;
  return { title: q ? `Search: ${q}` : 'Search' };
}

/**
 * Search results (#9): the header box submits `q` here (GET, so results
 * are linkable). Pagination is the same cursor-anchor walk as the post
 * thread; empty and degraded states cover a cold index right after a reset.
 */
export default async function SearchPage({ searchParams }: { searchParams: SearchParams }) {
  const { q, cursor } = await searchParams;
  const query = q?.trim() ?? '';
  // Gate before fetching; preserve the query in the login round-trip.
  const session = await requireSession(
    query ? `/search?q=${encodeURIComponent(query)}` : '/search',
  );

  const result = query
    ? await loadSearch(session, query, cursor)
    : { status: 'ok' as const, entries: [], nextCursor: null };

  return (
    <Container size="sm" py="xl">
      <Stack gap="md">
        <Title order={1} size="h3">
          Search
        </Title>

        <SearchBox defaultValue={query} />

        {query === '' ? (
          <Text size="sm" c="dimmed" data-testid="search-prompt">
            Search xitter posts by keyword or #hashtag.
          </Text>
        ) : result.status === 'degraded' ? (
          // Cold index / search outage: honest, non-erroring degradation.
          <Alert color="yellow" data-testid="search-degraded">
            Search is warming up and results are not available right now. Try again in a moment.
          </Alert>
        ) : result.entries.length === 0 ? (
          <Text size="sm" c="dimmed" data-testid="search-empty">
            No results for &ldquo;{query}&rdquo;.
          </Text>
        ) : (
          <>
            <Stack gap="md" data-testid="search-results">
              {result.entries.map(({ post, author }) => (
                <PostListItem
                  key={post.id}
                  post={post}
                  author={author}
                  canDelete={post.authorId === session.subject}
                />
              ))}
            </Stack>
            {result.nextCursor ? (
              <Box>
                <Anchor
                  href={`/search?q=${encodeURIComponent(query)}&cursor=${result.nextCursor}`}
                  size="sm"
                  data-testid="search-load-more"
                >
                  Load more
                </Anchor>
              </Box>
            ) : null}
          </>
        )}
      </Stack>
    </Container>
  );
}
