import { Alert, Container, Stack, Text, Title } from '@mantine/core';
import type { Metadata } from 'next';
import { requireSession } from '@/lib/auth/session';
import type { PostCardItem } from '@/components/paginated-post-list';
import { SearchBox } from '@/components/search-box';
import { loadSearch, type SearchResultPage } from './load-search';
import { SearchResults } from './search-results';

type SearchParams = Promise<{ q?: string }>;

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const { q } = await searchParams;
  return { title: q ? `Search: ${q}` : 'Search' };
}

/** Result body for one rendered state; the query input stays above it. */
function ResultBody({
  result,
  query,
  viewerId,
}: {
  result: SearchResultPage;
  query: string;
  viewerId: string;
}) {
  if (result.status === 'degraded') {
    // Cold index / search outage: honest, non-erroring degradation.
    return (
      <Alert color="yellow" data-testid="search-degraded">
        Search is warming up and results are not available right now. Try again in a moment.
      </Alert>
    );
  }
  if (result.entries.length === 0) {
    return (
      <Text size="sm" c="dimmed" data-testid="search-empty">
        No results for &ldquo;{query}&rdquo;.
      </Text>
    );
  }
  // Plain search result: no repost context (component omits the attribution
  // when undefined); replies keep their "Replying to @x" context (#147).
  const items: PostCardItem[] = result.entries.map(({ post, author, viewer, replyToAuthor }) => ({
    post,
    author,
    viewer,
    ...(replyToAuthor ? { replyToAuthor } : {}),
    canDelete: post.authorId === viewerId,
  }));
  return <SearchResults query={query} initialItems={items} initialCursor={result.nextCursor} />;
}

/**
 * Search results (#9): the header box submits `q` here (GET, so results
 * are linkable). Load more appends in place on the shared cursor pattern
 * (#41); empty and degraded states cover a cold index right after a reset.
 */
export default async function SearchPage({ searchParams }: { searchParams: SearchParams }) {
  const { q } = await searchParams;
  const query = q?.trim() ?? '';
  // Gate before fetching; preserve the query in the login round-trip.
  const session = await requireSession(
    query ? `/search?q=${encodeURIComponent(query)}` : '/search',
  );

  const result = query
    ? await loadSearch(session, query)
    : { status: 'ok' as const, entries: [], nextCursor: null };

  return (
    <Container size="sm" py="xl">
      <Stack gap="md">
        <Title order={1} size="h3">
          Search
        </Title>

        <SearchBox defaultValue={query} fluid />

        {query === '' ? (
          <Text size="sm" c="dimmed" data-testid="search-prompt">
            Search xitter posts by keyword or #hashtag.
          </Text>
        ) : (
          <ResultBody result={result} query={query} viewerId={session.subject} />
        )}
      </Stack>
    </Container>
  );
}
