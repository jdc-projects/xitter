'use client';

import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { PostComposer } from '@/components/post-composer';
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
 * The materialised timeline: composer + server-rendered page 1 +
 * client-side cursor pagination (Load more) + the ws-driven new-items banner
 * (spec 03: the notification is a refetch hint, never a data push). Fresh
 * own posts prepend optimistically (#148a) and a closed socket falls back
 * to polling (#148b).
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

/** #148b: poll cadence while the ws is down (banner is at-most-once). */
const POLL_WHEN_CLOSED_MS = 15_000;

export function FeedView({ initialEntries, initialCursor, viewerId }: FeedViewProps) {
  const { pages, cursor, loading, error, failedMode, loadMore, refresh } = useFeedPages(
    initialEntries,
    initialCursor,
  );
  const [newCount, setNewCount] = useState(0);
  // #148a: own posts created this session, client-side only until a real
  // fetch includes them.
  const [pending, setPending] = useState<TimelineEntry[]>([]);

  // ws notify hint → count, refetched on Show (spec 03: never a data push).
  const socketStatus = useFeedUpdates((count) => setNewCount((current) => current + count));

  // #148b: the socket is at-most-once with no delivery guarantee - while it
  // is closed, poll page 1 so a missed banner cannot silently mean a stale
  // feed. A hidden tab skips the fetch (the timer keeps its schedule).
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });
  useEffect(() => {
    if (socketStatus !== 'closed') return;
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      setNewCount(0);
      void refreshRef.current();
    }, POLL_WHEN_CLOSED_MS);
    return () => clearInterval(id);
  }, [socketStatus]);

  const serverEntries = pages.flat();
  // The optimistic copy lives exactly until the server knows the post too -
  // then the fetched entry (with server counts/flags) takes over.
  const serverPostIds = new Set(serverEntries.map((entry) => entry.post.id));
  const entries = [
    ...pending.filter((entry) => !serverPostIds.has(entry.post.id)),
    ...serverEntries,
  ];

  function prependPending({
    post,
    author,
  }: {
    post: TimelineEntry['post'];
    author: TimelineEntry['author'];
  }) {
    setPending((current) => [
      {
        post,
        author,
        viewer: { liked: false, reposted: false, bookmarked: false },
        pending: true,
      },
      ...current.filter((entry) => entry.post.id !== post.id),
    ]);
  }

  return (
    <>
      <PostComposer onPosted={prependPending} />

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
          Nothing here yet - the feed shows posts from accounts you follow. Write the first one
          above to get things started.
        </Text>
      ) : (
        <>
          <Stack gap="md" data-testid="feed-timeline">
            {entries.map(({ post, author, repostedBy, replyToAuthor, viewer, pending }) => (
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
                replyToAuthor={replyToAuthor}
                canDelete={post.authorId === viewerId}
                pending={pending}
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
