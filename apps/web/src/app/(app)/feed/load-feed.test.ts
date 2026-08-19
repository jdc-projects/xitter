import { describe, expect, it } from 'vitest';
import type { HydratedFeedItem } from '@xitter/api-contracts';
import { toTimelineEntries } from './load-feed';

const item = (postId: string, authorId: string, username: string): HydratedFeedItem => ({
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
});

// #7 feed mapping: the service pre-hydrates post + author server-side.
describe('toTimelineEntries', () => {
  it('maps hydrated items to render entries in service order (newest first)', () => {
    const entries = toTimelineEntries([item('p2', 'a1', 'me'), item('p1', 'a2', 'followed')]);

    expect(entries.map((entry) => entry.post.id)).toEqual(['p2', 'p1']);
    expect(entries[0]!.author).toEqual({ id: 'a1', username: 'me', displayName: 'Display me' });
  });

  it('keeps each entry author aligned with its post', () => {
    const entries = toTimelineEntries([item('p1', 'a2', 'followed')]);
    expect(entries[0]!.post.authorId).toBe(entries[0]!.author.id);
  });
});
