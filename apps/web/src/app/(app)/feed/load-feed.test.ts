import { describe, expect, it } from 'vitest';
import type { HydratedFeedItem } from '@xitter/api-contracts';
import { toTimelineEntries } from './load-feed';

const item = (
  postId: string,
  authorId: string,
  username: string,
  reposted?: HydratedFeedItem['repostedBy'],
): HydratedFeedItem => ({
  post: {
    id: postId,
    authorId,
    text: `post ${postId}`,
    media: [],
    replyToId: null,
    repostOfId: null,
    counts: { replies: 0, likes: 0, reposts: 0 },
    createdAt: '2026-08-18T09:00:00Z',
    deletedAt: null,
  },
  author: {
    id: authorId,
    username,
    displayName: `Display ${username}`,
    bio: null,
    createdAt: '2026-08-01T00:00:00Z',
  },
  reason: reposted ? 'repost' : 'post',
  repostedBy: reposted ?? null,
});

const noFlags = new Map<string, { liked: boolean; reposted: boolean; bookmarked: boolean }>();

// #7 feed mapping: the service pre-hydrates post + author server-side.
// #8 adds repost attribution + viewer flags riding the entry.
describe('toTimelineEntries', () => {
  it('maps hydrated items to render entries in service order (newest first)', () => {
    const entries = toTimelineEntries(
      [item('p2', 'a1', 'me'), item('p1', 'a2', 'followed')],
      noFlags,
    );

    expect(entries.map((entry) => entry.post.id)).toEqual(['p2', 'p1']);
    expect(entries[0]!.author).toEqual({ id: 'a1', username: 'me', displayName: 'Display me' });
  });

  it('keeps each entry author aligned with its post', () => {
    const entries = toTimelineEntries([item('p1', 'a2', 'followed')], noFlags);
    expect(entries[0]!.post.authorId).toBe(entries[0]!.author.id);
  });

  it('carries repost attribution only on repost entries', () => {
    const entries = toTimelineEntries(
      [
        item('p1', 'a2', 'followed'),
        item('p1', 'a3', 'reposter', {
          id: 'a3',
          username: 'reposter',
          displayName: 'Display reposter',
          bio: null,
          createdAt: '2026-08-01T00:00:00Z',
        }),
      ],
      noFlags,
    );

    expect(entries[0]!.repostedBy).toBeUndefined();
    expect(entries[1]!.repostedBy).toMatchObject({ id: 'a3', username: 'reposter' });
  });

  it('attaches viewer flags per post and defaults empty', () => {
    const flags = new Map([
      ['p1', { liked: true, reposted: false, bookmarked: true }],
    ]);
    const entries = toTimelineEntries([item('p1', 'a2', 'followed'), item('p2', 'a1', 'me')], flags);

    expect(entries[0]!.viewer).toEqual({ liked: true, reposted: false, bookmarked: true });
    expect(entries[1]!.viewer).toEqual({ liked: false, reposted: false, bookmarked: false });
  });
});
