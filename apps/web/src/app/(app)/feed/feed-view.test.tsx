import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider, createTheme } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Post } from '@xitter/api-contracts';
import { feedPageAction } from './actions';
import { FeedView } from './feed-view';
import type { TimelineEntry } from './load-feed';

// The ws hook is environment-heavy (token fetch, real WebSocket); the view
// only consumes its status + notification callback - stub both, controllably.
const ws = vi.hoisted(() => ({
  status: 'connecting' as 'connecting' | 'open' | 'closed',
  onNewItems: (_count: number) => {},
}));
vi.mock('./use-feed-updates', () => ({
  useFeedUpdates: (onNewItems: (count: number) => void): typeof ws.status => {
    ws.onNewItems = onNewItems;
    return ws.status;
  },
}));

vi.mock('./actions', () => ({ feedPageAction: vi.fn() }));

// The real composer drives a server action through the form; for the view's
// wiring only the onPosted handoff matters - stub it with a trigger button.
const posted = vi.hoisted(() => ({
  post: {
    id: '11111111-1111-4111-8111-111111111111',
    authorId: 'v1',
    text: 'fresh post',
    media: [],
    replyToId: null,
    repostOfId: null,
    counts: { replies: 0, likes: 0, reposts: 0 },
    createdAt: '2026-08-27T12:00:00.000Z',
    deletedAt: null,
  } satisfies Post,
  author: { id: 'v1', username: 'viewer', displayName: 'Viewer' },
}));
vi.mock('@/components/post-composer', () => ({
  PostComposer: ({ onPosted }: { onPosted?: (p: typeof posted) => void }) => (
    <button type="button" data-testid="stub-compose" onClick={() => onPosted?.(posted)}>
      compose
    </button>
  ),
}));

const serverEntry: TimelineEntry = {
  post: {
    id: '22222222-2222-4222-8222-222222222222',
    authorId: 'f1',
    text: 'older server post',
    media: [],
    replyToId: null,
    repostOfId: null,
    counts: { replies: 1, likes: 2, reposts: 0 },
    createdAt: '2026-08-27T10:00:00.000Z',
    deletedAt: null,
  },
  author: { id: 'f1', username: 'followed', displayName: 'Followed' },
  viewer: { liked: false, reposted: false, bookmarked: false },
};

function renderView(entries: TimelineEntry[] = [serverEntry]) {
  return render(
    <MantineProvider theme={createTheme({})}>
      <FeedView initialEntries={entries} initialCursor={null} viewerId="v1" />
    </MantineProvider>,
  );
}

beforeEach(() => {
  ws.status = 'connecting';
  // The module mock (and its call log) is shared across tests in this file.
  vi.mocked(feedPageAction).mockReset().mockResolvedValue({ entries: [], nextCursor: null });
});

// #148a: the composer's fresh own post prepends optimistically, and the
// next real fetch supersedes it.
describe('FeedView optimistic prepend (#148a)', () => {
  it('shows the fresh own post at the top, marked pending', () => {
    renderView();

    fireEvent.click(screen.getByTestId('stub-compose'));

    const timeline = screen.getByTestId('feed-timeline');
    const first = timeline.firstElementChild!;
    expect(first.getAttribute('data-testid')).toBe(`post-item-${posted.post.id}`);
    expect(first.getAttribute('data-pending')).toBe('true');
  });

  it('supersedes the optimistic entry once a real fetch includes the post', async () => {
    vi.mocked(feedPageAction).mockResolvedValue({
      entries: [
        {
          post: posted.post,
          author: posted.author,
          viewer: { liked: false, reposted: false, bookmarked: false },
        },
        serverEntry,
      ],
      nextCursor: null,
    });
    renderView();
    fireEvent.click(screen.getByTestId('stub-compose'));
    expect(screen.getAllByTestId(`post-item-${posted.post.id}`)).toHaveLength(1);

    // The ws banner's Show click is a real fetch - the server entry replaces
    // the optimistic one (no pending marker left).
    act(() => ws.onNewItems(1));
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));

    await waitFor(() => {
      expect(vi.mocked(feedPageAction).mock.calls).toHaveLength(1);
      expect(vi.mocked(feedPageAction).mock.calls[0]).toHaveLength(0); // page 1, no cursor
    });
    await waitFor(() => {
      const rows = screen.getAllByTestId(`post-item-${posted.post.id}`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.getAttribute('data-pending')).toBeNull();
    });
  });

  it('keeps the optimistic entry when a fetch does not include it yet (fanout lag)', async () => {
    vi.mocked(feedPageAction).mockResolvedValue({
      entries: [serverEntry],
      nextCursor: null,
    });
    renderView();
    fireEvent.click(screen.getByTestId('stub-compose'));

    act(() => ws.onNewItems(2));
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));

    await waitFor(() => {
      expect(vi.mocked(feedPageAction).mock.calls).toHaveLength(1);
    });
    // Honest, not flaky: the post the server does not know yet stays
    // visible client-side instead of vanishing.
    expect(screen.getByTestId(`post-item-${posted.post.id}`).getAttribute('data-pending')).toBe(
      'true',
    );
  });
});

// #148b: the ws banner is at-most-once - a closed socket falls back to
// polling page 1, paused while the tab is hidden.
describe('FeedView poll-when-ws-closed (#148b)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes page 1 on the poll interval while closed', async () => {
    vi.mocked(feedPageAction).mockResolvedValue({ entries: [serverEntry], nextCursor: null });
    renderView();
    act(() => {
      ws.status = 'closed';
      ws.onNewItems(1); // re-render so the hook mock's new status lands
    });

    expect(vi.mocked(feedPageAction).mock.calls).toHaveLength(0);
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });

    expect(vi.mocked(feedPageAction).mock.calls).toHaveLength(1);
    expect(vi.mocked(feedPageAction).mock.calls[0]).toHaveLength(0); // page 1, no cursor
    // The poll reconciles the banner it replaces.
    expect(screen.queryByTestId('feed-new-items')).toBeNull();
  });

  it('does not poll while the socket is open', async () => {
    vi.mocked(feedPageAction).mockResolvedValue({ entries: [serverEntry], nextCursor: null });
    renderView();
    act(() => {
      ws.status = 'open';
      ws.onNewItems(1);
    });

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(vi.mocked(feedPageAction).mock.calls).toHaveLength(0);
  });

  it('skips the fetch while the tab is hidden', async () => {
    vi.mocked(feedPageAction).mockResolvedValue({ entries: [serverEntry], nextCursor: null });
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      renderView();
      act(() => {
        ws.status = 'closed';
        ws.onNewItems(1);
      });

      await act(async () => {
        vi.advanceTimersByTime(45_000);
      });
      expect(vi.mocked(feedPageAction).mock.calls).toHaveLength(0);
    } finally {
      visibility.mockRestore();
    }
  });
});
