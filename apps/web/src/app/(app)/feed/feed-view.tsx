'use client';

import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { PostListItem } from '@/components/post-list-item';
import { feedPageAction } from './actions';
import type { TimelineEntry } from './load-feed';
import { useFeedUpdates } from './use-feed-updates';

export interface FeedViewProps {
  /** SSR-rendered page 1 (fast first paint, a11y-friendly markup). */
  initialEntries: TimelineEntry[];
  initialCursor: string | null;
  /** Own posts render the delete affordance. */
  viewerId: string;
}

/**
 * The materialised timeline: server-rendered page 1 + client-side cursor
 * pagination (Load more) + the ws-driven new-items banner (spec 03: the
 * notification is a refetch hint, never a data push).
 */
/**
 * Feed pagination state machine: page 1 (server-rendered, reset on
 * revalidation), cursor appends, and the retry's failed-mode memory. Kept
 * out of FeedView so the component stays under the complexity budget.
 */
function useFeedPages(initialEntries: TimelineEntry[], initialCursor: string | null) {
  const [pages, setPages] = useState<TimelineEntry[][]>([initialEntries]);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Which fetch mode the retry button should replay ('append' | 'refresh'). */
  const [failedMode, setFailedMode] = useState<'append' | 'refresh' | null>(null);

  // Server revalidation (a delete) re-renders page 1 - sync the reset during
  // render (same pattern as the composer's draft clearing).
  const [synced, setSynced] = useState(initialEntries);
  if (initialEntries !== synced) {
    setSynced(initialEntries);
    setPages([initialEntries]);
    setCursor(initialCursor);
  }

  async function loadMore() {
    if (loading || !cursor) return;
    setLoading(true);
    setError(null);
    setFailedMode(null);
    const page = await feedPageAction(cursor);
    if (page.error) {
      setError(page.error);
      setFailedMode('append');
    } else {
      setPages((current) => [...current, page.entries]);
      setCursor(page.nextCursor);
    }
    setLoading(false);
  }

  async function refresh() {
    if (loading) return;
    setLoading(true);
    setError(null);
    setFailedMode(null);
    const page = await feedPageAction(); // page 1
    if (page.error) {
      setError(page.error);
      setFailedMode('refresh');
    } else {
      setPages([page.entries]);
      setCursor(page.nextCursor);
    }
    setLoading(false);
  }

  return {
    pages,
    cursor,
    loading,
    error,
    failedMode,
    loadMore,
    refresh,
  };
}

export function FeedView({ initialEntries, initialCursor, viewerId }: FeedViewProps) {
  const { pages, cursor, loading, error, failedMode, loadMore, refresh } = useFeedPages(
    initialEntries,
    initialCursor,
  );
  const [newCount, setNewCount] = useState(0);

  // ws notify hint → count, refetched on Show (spec 03: never a data push).
  useFeedUpdates((count) => setNewCount((current) => current + count));

  const entries = pages.flat();

  return (
    <>
      {newCount > 0 ? (
        <Alert color="blue" py={6} data-testid="feed-new-items">
          <Group justify="space-between">
            <span>
              {newCount} new {newCount === 1 ? 'update' : 'updates'}
            </span>
            <Button
              size="compact-xs"
              variant="light"
              onClick={() => void (setNewCount(0), refresh())}
            >
              Show
            </Button>
          </Group>
        </Alert>
      ) : null}

      {entries.length === 0 ? (
        <Text size="sm" c="dimmed" data-testid="feed-empty">
          No posts yet - follow some accounts or write the first one above.
        </Text>
      ) : (
        <>
          <Stack gap="md" data-testid="feed-timeline">
            {entries.map(({ post, author, repostedBy, viewer }) => (
              <PostListItem
                // The same post can appear twice in one feed (as itself and
                // as a repost) - keying on post.id alone duplicates React
                // keys and mis-binds per-card interaction state on
                // re-renders. Entry identity is (post, kind).
                key={`${post.id}:${repostedBy?.id ?? 'post'}`}
                post={post}
                author={author}
                viewer={viewer}
                repostedBy={repostedBy}
                canDelete={post.authorId === viewerId}
              />
            ))}
          </Stack>
          {cursor ? (
            <Group justify="center">
              <Button
                variant="light"
                size="xs"
                loading={loading}
                onClick={() => void loadMore()}
                data-testid="load-more"
              >
                Load more
              </Button>
            </Group>
          ) : null}
        </>
      )}

      {error ? (
        <Alert color="red" data-testid="feed-error">
          <Group justify="space-between" gap="sm">
            <span>{error}</span>
            {/* Replay whichever fetch actually failed - the mode can differ
              from the current cursor state (e.g. a failed Show-new while
              scrolled). */}
            <Button
              size="compact-xs"
              variant="light"
              loading={loading}
              onClick={() => void (failedMode === 'append' ? loadMore() : refresh())}
              data-testid="feed-retry"
            >
              Try again
            </Button>
          </Group>
        </Alert>
      ) : null}
    </>
  );
}
