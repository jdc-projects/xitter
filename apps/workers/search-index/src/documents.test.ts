import { describe, expect, it } from 'vitest';
import {
  authorRefresh,
  documentFromPostCreated,
  keywordsFromText,
  tombstoneFromPostDeleted,
  UNKNOWN_AUTHOR,
} from './documents.js';

const AUTHOR = '00000000-0000-4000-8000-00000000a001';
const NOW = '2026-08-19T09:00:00.000Z';

const created = {
  eventType: 'posts.post.created' as const,
  postId: '00000000-0000-4000-8000-00000000c001',
  authorId: AUTHOR,
  text: 'Hello #Search world #search',
  mediaIds: [],
  replyToId: null,
  repostOfId: null,
  createdAt: NOW,
};

describe('keywordsFromText', () => {
  it('extracts hashtags, deduped and lowercased', () => {
    expect(keywordsFromText('Hello #Search world #search #Foo_Bar')).toEqual(['search', 'foo_bar']);
  });

  it('returns empty for plain text', () => {
    expect(keywordsFromText('no hashtags here')).toEqual([]);
  });
});

describe('documentFromPostCreated', () => {
  it('projects a live document with the resolved author name', () => {
    const doc = documentFromPostCreated(created, 'Demo User');
    expect(doc).toEqual({
      postId: created.postId,
      authorId: AUTHOR,
      authorName: 'Demo User',
      text: created.text,
      keywords: ['search'],
      createdAt: NOW,
      deletedAt: null,
    });
  });
});

describe('tombstoneFromPostDeleted', () => {
  it('projects a tombstone keyed by postId with deletedAt set', () => {
    const doc = tombstoneFromPostDeleted({
      eventType: 'posts.post.deleted',
      postId: created.postId,
      authorId: AUTHOR,
      deletedAt: NOW,
    });
    expect(doc.postId).toBe(created.postId);
    expect(doc.deletedAt).toBe(NOW);
    expect(doc.text).toBe('');
    expect(doc.authorName).toBe(UNKNOWN_AUTHOR);
  });
});

describe('authorRefresh', () => {
  it('maps profile.updated to an author-name refresh', () => {
    expect(
      authorRefresh({
        eventType: 'social.profile.updated',
        profileId: AUTHOR,
        username: 'demo1',
        displayName: 'Renamed',
        bio: null,
        updatedAt: NOW,
      }),
    ).toEqual({ authorId: AUTHOR, authorName: 'Renamed' });
  });
});
