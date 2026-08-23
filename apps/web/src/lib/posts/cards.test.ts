import { describe, expect, it } from 'vitest';
import type { Post } from '@xitter/api-contracts';
import { toPostCardItems } from './cards';

const post = (id: string, authorId: string): Post =>
  ({
    id,
    authorId,
    text: `text ${id}`,
    createdAt: '2026-08-21T00:00:00Z',
    counts: { likes: 0, reposts: 0, replies: 0 },
    media: [],
    replyToId: null,
  }) as unknown as Post;

describe('toPostCardItems (#41 server hydration for the client lists)', () => {
  it('joins author and viewer state onto each post', () => {
    const items = toPostCardItems(
      [post('p1', 'u1'), post('p2', 'u2')],
      new Map([
        ['u1', { id: 'u1', username: 'alice', displayName: 'Alice' }],
        ['u2', { id: 'u2', username: 'bob', displayName: 'Bob' }],
      ]),
      new Map([['p1', { postId: 'p1', liked: true, reposted: false, bookmarked: false }]]),
      'u2',
    );

    expect(items[0]).toMatchObject({
      author: { username: 'alice' },
      viewer: { liked: true },
      canDelete: false,
      username: 'alice',
    });
    expect(items[1]).toMatchObject({
      author: { username: 'bob' },
      viewer: undefined,
      // The viewer authored p2: the delete affordance is theirs.
      canDelete: true,
      username: 'bob',
    });
  });

  it('falls back to a placeholder author when hydration misses', () => {
    const items = toPostCardItems([post('p1', 'ghost')], new Map(), new Map(), 'u9');
    expect(items[0]?.author).toEqual({ id: 'ghost', username: 'unknown', displayName: 'Unknown' });
    expect(items[0]?.username).toBe('unknown');
  });
});
