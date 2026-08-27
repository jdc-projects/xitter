import { describe, expect, it } from 'vitest';
import type { Post, ThreadNode } from '@xitter/api-contracts';
import { leafNodesFromItems, threadTreePosts, toPostCardItems, toThreadItems } from './cards';

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

const node = (id: string, authorId: string, children: ThreadNode[] = []): ThreadNode => ({
  post: { ...post(id, authorId), counts: { likes: 0, reposts: 0, replies: children.length } },
  children,
  childrenTruncated: false,
});

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

describe('thread tree hydration (#152)', () => {
  const authors = new Map([
    ['u1', { id: 'u1', username: 'alice', displayName: 'Alice' }],
    ['u2', { id: 'u2', username: 'bob', displayName: 'Bob' }],
  ]);
  const states = new Map([
    ['r2', { postId: 'r2', liked: true, reposted: false, bookmarked: false }],
  ]);

  const tree: ThreadNode[] = [
    node('r1', 'u1', [node('r1a', 'u2'), node('r1b', 'u2')]),
    node('r2', 'u2'),
  ];

  it('threadTreePosts flattens the subtree depth-first for batch hydration', () => {
    expect(threadTreePosts(tree).map((p) => p.id)).toEqual(['r1', 'r1a', 'r1b', 'r2']);
  });

  it('toThreadItems hydrates every level and preserves nesting + flags', () => {
    const items = toThreadItems(tree, authors, states, 'u2');
    expect(items).toHaveLength(2);
    expect(items[0]?.author.username).toBe('alice');
    expect(items[0]?.children.map((child) => child.post.id)).toEqual(['r1a', 'r1b']);
    // Viewer flags and own-post markers ride the nested rows like the lists.
    expect(items[1]?.viewer).toMatchObject({ liked: true });
    expect(items[1]?.canDelete).toBe(true);
  });

  it('toThreadItems keeps placeholder authors and truncation flags for unhydrated gaps', () => {
    const [deep] = toThreadItems([node('x', 'ghost')], new Map(), new Map(), 'u9');
    expect(deep?.author).toEqual({ id: 'ghost', username: 'unknown', displayName: 'Unknown' });
    expect(deep?.childrenTruncated).toBe(false);
  });

  it('leafNodesFromItems turns flat /replies rows into expandable leaves', () => {
    const flat = toPostCardItems(
      [{ ...post('r3', 'u2'), counts: { likes: 0, reposts: 0, replies: 2 } }],
      authors,
      new Map(),
      'u1',
    );
    const [leaf] = leafNodesFromItems(flat);
    expect(leaf?.children).toEqual([]);
    // The node hides 2 direct replies: the branch offers to reveal them.
    expect(leaf?.childrenTruncated).toBe(true);
    expect(leaf?.canDelete).toBe(false);
  });
});
