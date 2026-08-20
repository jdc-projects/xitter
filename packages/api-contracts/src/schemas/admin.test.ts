import { describe, expect, it } from 'vitest';
import {
  adminAuditEntrySchema,
  adminDeletePostQuerySchema,
  adminHealthSchema,
  adminMediaListQuerySchema,
  adminPostPageSchema,
  adminPostsListQuerySchema,
} from './http.js';
import { postSchema } from './domain.js';

const basePost = {
  id: '9e8a7b6c-1234-4abc-9def-001122334455',
  authorId: '9e8a7b6c-1234-4abc-9def-001122334456',
  text: 'hello world',
  media: [],
  replyToId: null,
  repostOfId: null,
  counts: { replies: 0, likes: 0, reposts: 0 },
  createdAt: '2026-08-15T12:00:00.000Z',
  deletedAt: null,
};

describe('adminPostsListQuerySchema', () => {
  it('parses query-string shaped input (strings only)', () => {
    expect(
      adminPostsListQuerySchema.parse({
        authorId: '9e8a7b6c-1234-4abc-9def-001122334456',
        text: 'needle',
        deleted: 'true',
        limit: '50',
      }),
    ).toMatchObject({ deleted: 'true', limit: 50 });
  });

  it('defaults the limit and leaves filters absent (= all)', () => {
    expect(adminPostsListQuerySchema.parse({})).toEqual({ limit: 20 });
  });

  it('rejects a bogus deleted filter value', () => {
    expect(adminPostsListQuerySchema.safeParse({ deleted: 'maybe' }).success).toBe(false);
  });

  it('caps the limit', () => {
    expect(adminPostsListQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });
});

describe('adminDeletePostQuerySchema', () => {
  it('defaults to soft delete', () => {
    expect(adminDeletePostQuerySchema.parse({})).toEqual({ hard: 'false' });
  });

  it('accepts hard deletes', () => {
    expect(adminDeletePostQuerySchema.parse({ hard: 'true' })).toEqual({ hard: 'true' });
  });
});

describe('adminMediaListQuerySchema', () => {
  it('parses status + owner filters', () => {
    expect(
      adminMediaListQuerySchema.parse({
        ownerId: '9e8a7b6c-1234-4abc-9def-001122334456',
        status: 'ready',
      }),
    ).toMatchObject({ status: 'ready' });
  });

  it('rejects unknown statuses', () => {
    expect(adminMediaListQuerySchema.safeParse({ status: 'processing' }).success).toBe(false);
  });
});

describe('adminAuditEntrySchema', () => {
  it('accepts a moderation entry and rejects unknown actions', () => {
    const entry = {
      id: '9e8a7b6c-1234-4abc-9def-001122334459',
      actorId: 'localadmin-uuid',
      actorName: 'localadmin',
      action: 'post.soft-delete',
      targetId: basePost.id,
      detail: { hard: false },
      createdAt: '2026-08-20T01:02:03.000Z',
    };
    expect(adminAuditEntrySchema.parse(entry).action).toBe('post.soft-delete');
    expect(adminAuditEntrySchema.safeParse({ ...entry, action: 'post.purge' }).success).toBe(false);
  });
});

describe('adminHealthSchema', () => {
  it('round-trips a healthy service', () => {
    const health = {
      service: 'posts',
      status: 'ok',
      uptimeSeconds: 120,
      version: '1.0.0',
      checks: { database: { status: 'up' } },
    };
    expect(adminHealthSchema.parse(health).checks.database.status).toBe('up');
  });

  it('keeps a down check message', () => {
    const health = {
      service: 'posts',
      status: 'error',
      uptimeSeconds: 1,
      version: '1.0.0',
      checks: { database: { status: 'down', message: 'ping exceeded 2000ms' } },
    };
    expect(adminHealthSchema.parse(health).status).toBe('error');
  });
});

describe('admin page shapes carry deleted posts (moderation sees tombstones)', () => {
  it('parses a page containing a soft-deleted post', () => {
    const page = {
      items: [{ ...basePost, deletedAt: '2026-08-20T00:00:00.000Z' }],
      nextCursor: null,
    };
    expect(adminPostPageSchema.parse(page).items[0]!.deletedAt).toBe('2026-08-20T00:00:00.000Z');
    expect(postSchema.parse(page.items[0]).deletedAt).toBeTruthy();
  });
});
