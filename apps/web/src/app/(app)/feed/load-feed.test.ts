import { describe, expect, it } from 'vitest';
import type { Post, Profile } from '@xitter/api-contracts';
import { mergeFeedEntries } from './load-feed';

const profile = (id: string, username: string): Profile => ({
  id,
  username,
  displayName: `Display ${username}`,
  bio: null,
  createdAt: '2026-08-01T00:00:00Z',
});

const post = (id: string, authorId: string, createdAt: string): Post => ({
  id,
  authorId,
  text: `post ${id}`,
  media: [],
  replyToId: null,
  repostOfId: null,
  counts: { replies: 0, likes: 0, reposts: 0 },
  createdAt,
  deletedAt: null,
});

// INTERIM feed assembly (delete with #7): newest-first merge across authors.
describe('mergeFeedEntries', () => {
  it('merges per-author pages newest-first and tags each entry with its author', () => {
    const me = profile('00000000-0000-4000-8000-0000000000a1', 'me');
    const followed = profile('00000000-0000-4000-8000-0000000000b2', 'followed');
    const authors = new Map([
      [me.id, me],
      [followed.id, followed],
    ]);

    const merged = mergeFeedEntries(
      [
        { items: [post('p1', me.id, '2026-08-17T10:00:00Z'), post('p2', me.id, '2026-08-17T12:00:00Z')] },
        { items: [post('p3', followed.id, '2026-08-17T11:00:00Z')] },
      ],
      authors,
    );

    expect(merged.map((entry) => entry.post.id)).toEqual(['p2', 'p3', 'p1']);
    expect(merged[0]?.author.username).toBe('me');
    expect(merged[1]?.author.username).toBe('followed');
  });

  it('caps the window at 20 entries and drops posts without a known author', () => {
    const me = profile('00000000-0000-4000-8000-0000000000a1', 'me');
    const authors = new Map([[me.id, me]]);
    const items = Array.from({ length: 25 }, (_, n) =>
      post(`p${n}`, n % 5 === 0 ? 'unknown-author' : me.id, `2026-08-17T${String(n).padStart(2, '0')}:00:00Z`),
    );

    const merged = mergeFeedEntries([{ items }], authors);

    expect(merged).toHaveLength(20);
    expect(merged.every((entry) => entry.post.authorId === me.id)).toBe(true);
  });

  it('survives an author whose page failed (empty items)', () => {
    const me = profile('00000000-0000-4000-8000-0000000000a1', 'me');
    const merged = mergeFeedEntries(
      [{ items: [] }, { items: [post('p1', me.id, '2026-08-17T10:00:00Z')] }],
      new Map([[me.id, me]]),
    );
    expect(merged.map((entry) => entry.post.id)).toEqual(['p1']);
  });
});
