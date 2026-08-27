import { CanActivate, Controller, Get, type ExecutionContext } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ErrorEnvelopeFilter, RateLimitGuard } from '@xitter/auth-nest';
import { afterEach, describe, expect, it } from 'vitest';
import { InternalController } from './internal.controller.js';
import { NullInteractionRealtime, INTERACTION_REALTIME } from './interaction-realtime.js';
import { MEDIA_CHECKER, NullMediaChecker } from './media-checker.js';
import { NullPostsEvents, POSTS_EVENTS } from './posts-events.js';
import { PostsController } from './posts.controller.js';
import { PostsRepository } from './posts.repository.js';
import { PostsService } from './posts.service.js';
import { NullRelationshipChecker, RELATIONSHIP_CHECKER } from './relationship-checker.js';

/**
 * HTTP wiring: versioned public prefix, internal routes OUTSIDE it (spec 03),
 * zod validation -> error envelope, 201 create / 204 delete. The global
 * AuthGuard is stood in for by a stub principal (token validation is
 * @xitter/auth-nest's own test surface).
 */

const CALLER = '00000000-0000-4000-8000-0000000000c1';
const POST_ID = '00000000-0000-4000-8000-0000000000d1';

@Controller('placeholder')
class PlaceholderController {
  @Get()
  find() {
    return { ok: true };
  }
}

/** Stub global guard: every request is CALLER. */
const stubAuthGuard: CanActivate = {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest<{ user?: unknown }>().user = {
      subject: CALLER,
      username: 'democaller',
      roles: [],
      service: false,
    };
    return true;
  },
};

const postRow = (overrides: Record<string, unknown> = {}) => ({
  id: POST_ID,
  authorId: CALLER,
  text: 'hello xitter',
  mediaIds: [],
  replyToId: null,
  repostOfId: null,
  createdAt: new Date('2026-08-17T00:00:00Z'),
  deletedAt: null,
  replyCount: 0,
  likeCount: 0,
  repostCount: 0,
  ...overrides,
});

const repoStub = {
  findPost: () => Promise.resolve(postRow()),
  findVisiblePost: () => Promise.resolve(postRow()),
  createPost: (input: { authorId: string; text: string }) =>
    Promise.resolve(postRow({ ...input, id: '00000000-0000-4000-8000-0000000000e1' })),
  softDelete: () => Promise.resolve(postRow({ deletedAt: new Date() })),
  authorPosts: () => Promise.resolve({ items: [postRow()], nextCursor: null }),
  replies: () => Promise.resolve({ items: [], nextCursor: null }),
  bookmarks: () => Promise.resolve({ items: [postRow()], nextCursor: null }),
  interactionsForPosts: () => Promise.resolve([{ kind: 'like', postId: POST_ID } as const]),
  createInteraction: () =>
    Promise.resolve({
      row: {
        id: '00000000-0000-4000-8000-0000000000f1',
        kind: 'like',
        postId: POST_ID,
        userId: CALLER,
        createdAt: new Date('2026-08-19T00:00:00Z'),
      },
      created: true,
    }),
  deleteInteraction: () => Promise.resolve(true),
  truncate: () => Promise.resolve(),
  toCounts: () => ({ replies: 0, likes: 0, reposts: 0 }),
} as unknown as PostsRepository;

async function createApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [PostsController, InternalController, PlaceholderController],
    providers: [
      { provide: PostsRepository, useValue: repoStub },
      { provide: POSTS_EVENTS, useValue: new NullPostsEvents() },
      { provide: RELATIONSHIP_CHECKER, useValue: new NullRelationshipChecker() },
      { provide: MEDIA_CHECKER, useValue: new NullMediaChecker() },
      { provide: INTERACTION_REALTIME, useValue: new NullInteractionRealtime() },
      PostsService,
    ],
  })
    .overrideGuard(RateLimitGuard)
    .useValue({ canActivate: () => true })
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalGuards(stubAuthGuard);
  // Exactly like main.ts: service-level prefix, `v1` on the public
  // controller, `internal` without a version.
  app.setGlobalPrefix('api/posts');
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  await app.init();
  return app;
}

describe('posts HTTP wiring', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('creates posts under the versioned prefix with the contract response', async () => {
    app = await createApp();

    const created = await app.inject({
      method: 'POST',
      url: '/api/posts/v1/posts',
      payload: { text: 'hello xitter' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      authorId: CALLER,
      text: 'hello xitter',
      counts: { replies: 0, likes: 0, reposts: 0 },
      media: [],
      deletedAt: null,
    });
  });

  it('rejects invalid bodies with the error envelope (513 chars, unknown keys)', async () => {
    app = await createApp();

    const tooLong = await app.inject({
      method: 'POST',
      url: '/api/posts/v1/posts',
      payload: { text: 'x'.repeat(513) },
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const unknownKey = await app.inject({
      method: 'POST',
      url: '/api/posts/v1/posts',
      payload: { text: 'x', username: 'hijack' },
    });
    expect(unknownKey.statusCode).toBe(400);

    const badMedia = await app.inject({
      method: 'POST',
      url: '/api/posts/v1/posts',
      payload: { text: 'x', mediaIds: ['not-a-uuid'] },
    });
    expect(badMedia.statusCode).toBe(400);
  });

  it('returns 204 from delete and rejects bad params', async () => {
    app = await createApp();

    const removed = await app.inject({ method: 'DELETE', url: `/api/posts/v1/posts/${POST_ID}` });
    expect(removed.statusCode).toBe(204);

    const badParam = await app.inject({ method: 'DELETE', url: '/api/posts/v1/posts/not-a-uuid' });
    expect(badParam.statusCode).toBe(400);
    expect(badParam.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('serves reads with pagination validation', async () => {
    app = await createApp();

    const post = await app.inject({ method: 'GET', url: `/api/posts/v1/posts/${POST_ID}` });
    expect(post.statusCode).toBe(200);
    expect(post.json()).toMatchObject({ id: POST_ID });

    const timeline = await app.inject({
      method: 'GET',
      url: `/api/posts/v1/users/${CALLER}/posts`,
    });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json()).toMatchObject({
      items: [{ id: POST_ID }],
      nextCursor: null,
    });

    const replies = await app.inject({
      method: 'GET',
      url: `/api/posts/v1/posts/${POST_ID}/replies`,
    });
    expect(replies.statusCode).toBe(200);
    expect(replies.json()).toEqual({ items: [], nextCursor: null });

    const badCursor = await app.inject({
      method: 'GET',
      url: `/api/posts/v1/users/${CALLER}/posts?cursor=${encodeURIComponent('%00zz-not-base64')}`,
    });
    expect(badCursor.statusCode).toBe(400);

    const badLimit = await app.inject({
      method: 'GET',
      url: `/api/posts/v1/users/${CALLER}/posts?limit=999`,
    });
    expect(badLimit.statusCode).toBe(400);
  });

  it('serves internal reseed outside the versioned prefix', async () => {
    app = await createApp();

    const reseed = await app.inject({ method: 'POST', url: '/api/posts/internal/reseed' });
    expect(reseed.statusCode).toBe(200);
    expect(reseed.json()).toEqual({ ok: true });

    const versioned = await app.inject({ method: 'POST', url: '/api/posts/v1/internal/reseed' });
    expect(versioned.statusCode).toBe(404);
  });

  it('serves the seed-only internal create with an explicit createdAt (#150)', async () => {
    app = await createApp();
    const AUTHOR_ID = '00000000-0000-4000-8000-0000000000a1';

    const created = await app.inject({
      method: 'POST',
      url: '/api/posts/internal/posts',
      payload: {
        authorId: AUTHOR_ID,
        text: 'back-dated corpus post',
        createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ text: 'back-dated corpus post' });

    // Schema: authorId/createdAt are required on this path.
    const missing = await app.inject({
      method: 'POST',
      url: '/api/posts/internal/posts',
      payload: { text: 'x' },
    });
    expect(missing.statusCode).toBe(400);

    // Service rule: future stamps are a loud 400, not clamped.
    const future = await app.inject({
      method: 'POST',
      url: '/api/posts/internal/posts',
      payload: {
        authorId: AUTHOR_ID,
        text: 'x',
        createdAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(future.statusCode).toBe(400);
    expect(future.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('serves interaction create/delete under the versioned prefix', async () => {
    app = await createApp();

    const created = await app.inject({
      method: 'POST',
      url: `/api/posts/v1/posts/${POST_ID}/interactions`,
      payload: { kind: 'like' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ kind: 'like', postId: POST_ID, userId: CALLER });

    const badKind = await app.inject({
      method: 'POST',
      url: `/api/posts/v1/posts/${POST_ID}/interactions`,
      payload: { kind: 'superlike' },
    });
    expect(badKind.statusCode).toBe(400);
    expect(badKind.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/posts/v1/posts/${POST_ID}/interactions/like`,
    });
    expect(removed.statusCode).toBe(204);

    const badParam = await app.inject({
      method: 'DELETE',
      url: `/api/posts/v1/posts/${POST_ID}/interactions/not-a-kind`,
    });
    expect(badParam.statusCode).toBe(400);
  });

  it('serves bookmarks and viewer-state with validation', async () => {
    app = await createApp();

    const bookmarks = await app.inject({ method: 'GET', url: '/api/posts/v1/bookmarks' });
    expect(bookmarks.statusCode).toBe(200);
    expect(bookmarks.json()).toMatchObject({
      items: [{ id: POST_ID }],
      nextCursor: null,
    });

    const state = await app.inject({
      method: 'GET',
      url: `/api/posts/v1/viewer-state?postIds=${POST_ID}`,
    });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toEqual({
      items: [{ postId: POST_ID, liked: true, reposted: false, bookmarked: false }],
    });

    const badState = await app.inject({ method: 'GET', url: '/api/posts/v1/viewer-state' });
    expect(badState.statusCode).toBe(400);
    expect(badState.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
});
