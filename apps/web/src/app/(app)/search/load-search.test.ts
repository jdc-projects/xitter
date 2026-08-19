import { describe, expect, it, vi, beforeEach } from 'vitest';

// The api-client is mocked at the module boundary: loadSearch's contract is
// the mapping + degradation behaviour, not the HTTP transport.
vi.mock('@xitter/api-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@xitter/api-client')>();
  return {
    ...original,
    SearchClient: vi.fn(),
    localServiceUrls: () => ({ search: 'http://localhost:8105' }),
  };
});

import { SearchClient } from '@xitter/api-client';
import { loadSearch } from './load-search';
import type { Session } from '@/lib/auth/session';

const session: Session = {
  id: 's',
  subject: 'u1',
  username: 'demo1',
  accessToken: 'token',
};

const searchPosts = vi.fn();

beforeEach(() => {
  searchPosts.mockReset();
  // Constructable mock: `new SearchClient(...)` returns this object (a
  // constructor returning an object replaces the instance).
  vi.mocked(SearchClient).mockImplementation(function mockSearchClient(this: unknown) {
    return { searchPosts };
  } as unknown as () => SearchClient);
});

describe('loadSearch', () => {
  it('maps a results page to timeline entries with the next cursor', async () => {
    searchPosts.mockResolvedValue({
      items: [
        {
          post: {
            id: 'p1',
            authorId: 'a1',
            text: 'hit',
            media: [],
            replyToId: null,
            repostOfId: null,
            counts: { replies: 0, likes: 0, reposts: 0 },
            createdAt: '2026-08-19T09:00:00Z',
            deletedAt: null,
          },
          author: {
            id: 'a1',
            username: 'author',
            displayName: 'Author',
            bio: null,
            createdAt: '2026-08-01T00:00:00Z',
          },
        },
      ],
      nextCursor: 'next',
    });

    const page = await loadSearch(session, 'hit', undefined);

    expect(searchPosts).toHaveBeenCalledWith('hit', undefined, 20);
    expect(page.status).toBe('ok');
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]!.author.username).toBe('author');
    expect(page.nextCursor).toBe('next');
  });

  it('degrades (never throws) when the search backend is unreachable', async () => {
    searchPosts.mockRejectedValue(new Error('cold index'));

    const page = await loadSearch(session, 'anything');

    expect(page).toEqual({ status: 'degraded', entries: [], nextCursor: null });
  });
});
