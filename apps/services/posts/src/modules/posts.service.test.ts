import { describe, expect, it, vi } from 'vitest';
import { createPostRequestSchema, POST_MEDIA_MAX, POST_TEXT_MAX } from '@xitter/api-contracts';
import type { MediaAsset } from '@xitter/api-contracts';
import { BACKDATE_WINDOW_MS, PostsService } from './posts.service.js';
import { MediaServiceChecker, NullMediaChecker, type MediaChecker } from './media-checker.js';
import { NullInteractionRealtime } from './interaction-realtime.js';
import type { PostsEvents } from './posts-events.js';
import type { PostsRepository, PostRow } from './posts.repository.js';
import type { RelationshipChecker } from './relationship-checker.js';

// Capture the service's structured logs without pino's stdout transport, so
// the LOUD emit-failure path (#149) can assert on the logged post id.
const loggerError = vi.hoisted(() => vi.fn());
vi.mock('@xitter/observability', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: loggerError }),
  };
});

const AUTHOR = '00000000-0000-4000-8000-000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';

const row = (overrides: Partial<PostRow> = {}): PostRow => ({
  id: '00000000-0000-4000-8000-000000000a01',
  authorId: AUTHOR,
  text: 'hello xitter',
  mediaIds: [],
  media: [],
  replyToId: null,
  repostOfId: null,
  createdAt: new Date('2026-08-17T00:00:00Z'),
  deletedAt: null,
  replyCount: 0,
  likeCount: 0,
  repostCount: 0,
  ...overrides,
});

function fakeRepo(overrides: Partial<PostsRepository> = {}) {
  const posts = new Map<string, PostRow>();
  const repo = {
    findPost: (id: string) => Promise.resolve(posts.get(id) ?? null),
    findVisiblePost: (id: string) => {
      const found = posts.get(id);
      return Promise.resolve(found && !found.deletedAt ? found : null);
    },
    createPost: (input: {
      authorId: string;
      text: string;
      mediaIds: string[];
      replyToId: string | null;
    }) => {
      const created = row({ id: crypto.randomUUID(), ...input });
      posts.set(created.id, created);
      return Promise.resolve(created);
    },
    softDelete: (id: string) => {
      const found = posts.get(id);
      if (!found || found.deletedAt) return Promise.resolve(null);
      const deleted = { ...found, deletedAt: new Date() };
      posts.set(id, deleted);
      return Promise.resolve(deleted);
    },
    authorPosts: () => Promise.resolve({ items: [...posts.values()], nextCursor: null }),
    replies: () => Promise.resolve({ items: [], nextCursor: null }),
    truncate: () => {
      posts.clear();
      return Promise.resolve();
    },
    toCounts: (r: PostRow) => ({
      replies: r.replyCount,
      likes: r.likeCount,
      reposts: r.repostCount,
    }),
    ...overrides,
  } as unknown as PostsRepository;
  return { repo, posts };
}

function spyEvents(): PostsEvents & { calls: [string, Record<string, unknown>][] } {
  const calls: [string, Record<string, unknown>][] = [];
  return {
    calls,
    emit: (eventType, payload) => {
      calls.push([eventType, payload]);
      return Promise.resolve();
    },
    shutdown: () => Promise.resolve(),
  };
}

const allowAll: RelationshipChecker = { blockedEitherWay: () => Promise.resolve(false) };

describe('createPostRequestSchema (contract)', () => {
  it('accepts a minimal text-only body and defaults mediaIds/replyToId', () => {
    expect(createPostRequestSchema.parse({ text: 'hi' })).toEqual({
      text: 'hi',
      mediaIds: [],
      replyToId: null,
    });
  });

  it(`rejects ${POST_TEXT_MAX + 1}-character text`, () => {
    expect(createPostRequestSchema.safeParse({ text: 'x'.repeat(POST_TEXT_MAX + 1) }).success).toBe(
      false,
    );
  });

  it('rejects empty text', () => {
    expect(createPostRequestSchema.safeParse({ text: '' }).success).toBe(false);
  });

  it(`rejects more than ${POST_MEDIA_MAX} media ids and non-uuid shapes`, () => {
    const uuid = '00000000-0000-4000-8000-00000000000m';
    expect(
      createPostRequestSchema.safeParse({
        text: 'x',
        mediaIds: Array(POST_MEDIA_MAX + 1).fill(uuid),
      }).success,
    ).toBe(false);
    expect(createPostRequestSchema.safeParse({ text: 'x', mediaIds: ['not-a-uuid'] }).success).toBe(
      false,
    );
  });

  it('is strict: unknown keys are rejected, not stripped', () => {
    expect(createPostRequestSchema.safeParse({ text: 'x', username: 'hijack' }).success).toBe(
      false,
    );
  });
});

describe('PostsService media attach rules', () => {
  const mediaId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  const readyAsset = (id: string): MediaAsset => ({
    id,
    ownerId: AUTHOR,
    status: 'ready',
    variants: [
      {
        kind: 'thumb',
        objectKey: `${AUTHOR}/${id}/thumb.png`,
        mimeType: 'image/png',
        bytes: 100,
        width: 10,
        height: 10,
        url: `/media/${AUTHOR}/${id}/thumb.png`,
      },
    ],
    createdAt: '2026-08-18T00:00:00.000Z',
  });

  /** Checker whose resolved set the tests control per case. */
  const checkerOver = (
    resolve: (ownerId: string, ids: string[], altTexts: Record<string, string>) => MediaAsset[],
  ): MediaChecker => ({
    resolveForAttach: (ownerId, ids, altTexts = {}) =>
      Promise.resolve(resolve(ownerId, ids, altTexts)),
  });

  it('attaches ready assets and snapshots them for reads', async () => {
    const { repo } = fakeRepo();
    const events = spyEvents();
    const service = new PostsService(
      repo,
      events,
      allowAll,
      checkerOver((_owner, ids) => ids.map(readyAsset)),
      new NullInteractionRealtime(),
    );

    const post = await service.create(AUTHOR, {
      text: 'with image',
      mediaIds: [mediaId(1)],
      replyToId: null,
    });

    expect(post.media).toEqual([readyAsset(mediaId(1))]);
    expect(events.calls[0]![1]).toMatchObject({ mediaIds: [mediaId(1)] });
  });

  it('forwards per-attachment alt text to media and snapshots the answer (#133)', async () => {
    const { repo } = fakeRepo();
    const seen: Array<{ ids: string[]; altTexts: Record<string, string> }> = [];
    const withAlt = (id: string, altText: string): MediaAsset => ({
      ...readyAsset(id),
      altText,
    });
    const service = new PostsService(
      repo,
      spyEvents(),
      allowAll,
      checkerOver((owner, ids, altTexts) => {
        seen.push({ ids: [...ids], altTexts: { ...altTexts } });
        return ids.map((id) => (altTexts[id] ? withAlt(id, altTexts[id]!) : readyAsset(id)));
      }),
      new NullInteractionRealtime(),
    );

    const post = await service.create(AUTHOR, {
      text: 'described images',
      mediaIds: [
        { mediaId: mediaId(1), altText: 'A kite over the pier' },
        mediaId(2), // mixed forms: bare id stays alt-less
      ],
      replyToId: null,
    });

    // Validation + persistence see the text via the same lookup call.
    expect(seen).toEqual([
      { ids: [mediaId(1), mediaId(2)], altTexts: { [mediaId(1)]: 'A kite over the pier' } },
    ]);
    // The stored snapshot renders the alt text exactly where it was given.
    expect(post.media).toEqual([
      withAlt(mediaId(1), 'A kite over the pier'),
      readyAsset(mediaId(2)),
    ]);
  });

  it('rejects non-ready (pending) media with the offending ids', async () => {
    const { repo } = fakeRepo();
    const pending = { ...readyAsset(mediaId(2)), status: 'pending' as const };
    const service = new PostsService(
      repo,
      spyEvents(),
      allowAll,
      checkerOver(() => [pending]),
      new NullInteractionRealtime(),
    );

    await expect(
      service.create(AUTHOR, { text: 'too soon', mediaIds: [mediaId(2)], replyToId: null }),
    ).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({
        error: expect.objectContaining({
          code: 'VALIDATION_ERROR',
          details: { invalidMediaIds: [mediaId(2)] },
        }),
      }),
    });
  });

  it('rejects ids the lookup did not resolve (missing or not owned)', async () => {
    const { repo } = fakeRepo();
    const service = new PostsService(
      repo,
      spyEvents(),
      allowAll,
      checkerOver(() => []),
      new NullInteractionRealtime(),
    );

    await expect(
      service.create(AUTHOR, { text: 'not mine', mediaIds: [mediaId(3)], replyToId: null }),
    ).rejects.toMatchObject({ response: { error: { code: 'VALIDATION_ERROR' } } });
  });

  it('propagates the fail-closed checker error (media unreachable)', async () => {
    const { repo } = fakeRepo();
    const unreachable: MediaChecker = {
      resolveForAttach: () => Promise.reject(new Error('media down')),
    };
    const service = new PostsService(
      repo,
      spyEvents(),
      allowAll,
      unreachable,
      new NullInteractionRealtime(),
    );

    await expect(
      service.create(AUTHOR, { text: 'x', mediaIds: [mediaId(4)], replyToId: null }),
    ).rejects.toThrow('media down');
  });
});

describe('media outage during post-create (fail-closed attach)', () => {
  const CHECKER_OPTS = {
    baseUrl: 'http://media.local:8104',
    tokenUrl: 'http://keycloak.local:8090/realms/xitter-demo/protocol/openid-connect/token',
    clientId: 'svc-posts',
    clientSecret: 'svc-posts-local-secret',
  };
  // Contract-valid ids: the checker parses media's answer with the shared
  // zod schemas, so the resolved assets must satisfy mediaAssetSchema.
  const WRITER = '00000000-0000-4000-8000-0000000000f1';
  const IMG = '00000000-0000-4000-8000-0000000005e1';

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

  /** What a healthy media answers the internal lookup for the given ids. */
  const lookupBody = (ids: string[]) => ({
    items: ids.map((id) => ({
      id,
      ownerId: WRITER,
      status: 'ready',
      variants: [],
      createdAt: '2026-08-18T00:00:00.000Z',
    })),
  });

  it('503s and leaves no orphaned post row behind', async () => {
    const { repo, posts } = fakeRepo();
    const events = spyEvents();
    const outage: typeof fetch = async () => {
      throw new Error('connect ECONNREFUSED 10.42.7.19:8104');
    };
    const service = new PostsService(
      repo,
      events,
      allowAll,
      new MediaServiceChecker({ ...CHECKER_OPTS, fetchImpl: outage }),
      new NullInteractionRealtime(),
    );

    await expect(
      service.create(WRITER, { text: 'with image', mediaIds: [IMG], replyToId: null }),
    ).rejects.toMatchObject({
      status: 503,
      response: { error: { code: 'INTERNAL' } },
    });

    // Rollback semantics: validation precedes the write, so the outage must
    // not leave a post row (or a created event feeding fanout) behind.
    expect(posts.size).toBe(0);
    expect(events.calls).toHaveLength(0);
  });

  it('still creates text-only posts while media is unreachable', async () => {
    const { repo, posts } = fakeRepo();
    const outage: typeof fetch = async () => {
      throw new Error('connect ECONNREFUSED 10.42.7.19:8104');
    };
    const service = new PostsService(
      repo,
      spyEvents(),
      allowAll,
      new MediaServiceChecker({ ...CHECKER_OPTS, fetchImpl: outage }),
      new NullInteractionRealtime(),
    );

    await expect(
      service.create(WRITER, { text: 'words only', mediaIds: [], replyToId: null }),
    ).resolves.toMatchObject({ text: 'words only', media: [] });
    expect(posts.size).toBe(1); // no mediaIds → the checker is never consulted
  });

  it('the retried create succeeds once media recovers', async () => {
    const { repo, posts } = fakeRepo();
    const events = spyEvents();
    let mediaUp = false;
    const flapping: typeof fetch = async (input) => {
      if (!mediaUp) throw new Error('connect ECONNREFUSED 10.42.7.19:8104');
      if (String(input).endsWith('/token')) {
        return jsonResponse({ access_token: 'm2m-token', expires_in: 300 });
      }
      return jsonResponse(lookupBody([IMG]));
    };
    const service = new PostsService(
      repo,
      events,
      allowAll,
      new MediaServiceChecker({ ...CHECKER_OPTS, fetchImpl: flapping }),
      new NullInteractionRealtime(),
    );

    await expect(
      service.create(WRITER, { text: 'retry me', mediaIds: [IMG], replyToId: null }),
    ).rejects.toMatchObject({ status: 503 });

    mediaUp = true;
    const post = await service.create(WRITER, {
      text: 'retry me',
      mediaIds: [IMG],
      replyToId: null,
    });

    expect(post.media).toMatchObject([{ id: IMG, status: 'ready' }]);
    expect(posts.size).toBe(1); // exactly the retried row - no orphan from the outage
    expect(events.calls).toHaveLength(1);
  });

  it('service-level validation rejects non-http callers without writing a row', async () => {
    const { repo, posts } = fakeRepo();
    const service = new PostsService(
      repo,
      spyEvents(),
      allowAll,
      new NullMediaChecker(),
      new NullInteractionRealtime(),
    );

    await expect(
      service.create(WRITER, { text: '', mediaIds: [], replyToId: null }),
    ).rejects.toMatchObject({ response: { error: { code: 'VALIDATION_ERROR' } } });
    expect(posts.size).toBe(0); // the 1..512 rule holds for seed/internal callers too
  });
});

describe('PostsService rules', () => {
  it('creates a post with zero-initialised counts and emits the full payload', async () => {
    const { repo } = fakeRepo();
    const events = spyEvents();
    const service = new PostsService(
      repo,
      events,
      allowAll,
      new NullMediaChecker(),
      new NullInteractionRealtime(),
    );

    const post = await service.create(AUTHOR, {
      text: 'first post',
      mediaIds: [],
      replyToId: null,
    });

    expect(post.counts).toEqual({ replies: 0, likes: 0, reposts: 0 });
    expect(post.deletedAt).toBeNull();
    expect(events.calls).toHaveLength(1);
    const [type, payload] = events.calls[0]!;
    expect(type).toBe('posts.post.created');
    expect(payload).toMatchObject({
      postId: post.id,
      authorId: AUTHOR,
      text: 'first post',
      mediaIds: [],
      replyToId: null,
      repostOfId: null,
    });
  });

  it('emits mediaIds and replyToId through the created event', async () => {
    const { repo, posts } = fakeRepo();
    const events = spyEvents();
    const parent = row({ id: '00000000-0000-4000-8000-000000000a11' });
    posts.set(parent.id, parent);
    const service = new PostsService(
      repo,
      events,
      allowAll,
      new NullMediaChecker(),
      new NullInteractionRealtime(),
    );

    await service.create(OTHER, {
      text: 'a reply',
      mediaIds: ['00000000-0000-4000-8000-0000000003d1'],
      replyToId: parent.id,
    });

    expect(events.calls[0]?.[1]).toMatchObject({
      replyToId: parent.id,
      mediaIds: ['00000000-0000-4000-8000-0000000003d1'],
    });
  });

  it('rejects replies to missing or deleted parents', async () => {
    const { repo, posts } = fakeRepo();
    const service = new PostsService(
      repo,
      spyEvents(),
      allowAll,
      new NullMediaChecker(),
      new NullInteractionRealtime(),
    );

    await expect(
      service.create(AUTHOR, { text: 'x', mediaIds: [], replyToId: OTHER }),
    ).rejects.toMatchObject({ response: { error: { code: 'NOT_FOUND' } } });

    const deleted = row({ id: '00000000-0000-4000-8000-000000000a12', deletedAt: new Date() });
    posts.set(deleted.id, deleted);
    await expect(
      service.create(AUTHOR, { text: 'x', mediaIds: [], replyToId: deleted.id }),
    ).rejects.toMatchObject({ response: { error: { code: 'NOT_FOUND' } } });
  });

  it('rejects replies when blocked in either direction, without checking on self-replies', async () => {
    const { repo } = fakeRepo();
    const parent = row({ id: '00000000-0000-4000-8000-000000000a13' });
    (repo.findVisiblePost as (id: string) => Promise<PostRow | null>) = (id) =>
      Promise.resolve(id === parent.id ? parent : null);

    const calls: [string, string][] = [];
    const blockedChecker: RelationshipChecker = {
      blockedEitherWay: (viewerId, otherId) => {
        calls.push([viewerId, otherId]);
        return Promise.resolve(true);
      },
    };
    const service = new PostsService(
      repo,
      spyEvents(),
      blockedChecker,
      new NullMediaChecker(),
      new NullInteractionRealtime(),
    );

    await expect(
      service.create(OTHER, { text: 'reply', mediaIds: [], replyToId: parent.id }),
    ).rejects.toMatchObject({ response: { error: { code: 'FORBIDDEN' } } });
    // social is asked about (replier, author) - the pair the block lives on.
    expect(calls).toEqual([[OTHER, AUTHOR]]);

    // Self-replies skip the social call entirely (no block can exist).
    await expect(
      service.create(AUTHOR, { text: 'self thread', mediaIds: [], replyToId: parent.id }),
    ).resolves.toMatchObject({ replyToId: parent.id });
    expect(calls).toHaveLength(1);
  });

  it('logs a loud structured error with the post id when the Kafka emit fails, without failing the mutation (#149)', async () => {
    loggerError.mockClear();
    const { repo } = fakeRepo();
    const events: PostsEvents = {
      emit: vi.fn(() => Promise.reject(new Error('kafka down'))),
      shutdown: () => Promise.resolve(),
    };
    const service = new PostsService(
      repo,
      events,
      allowAll,
      new NullMediaChecker(),
      new NullInteractionRealtime(),
    );

    const post = await service.create(AUTHOR, {
      text: 'lost event',
      mediaIds: [],
      replyToId: null,
    });

    // The write already committed: the user's action must still succeed.
    expect(post.deletedAt).toBeNull();
    expect((await service.getPost(post.id)).id).toBe(post.id);
    // And the swallow is LOUD: structured context carries the post id, so a
    // missing feed/search item is traceable from the posts logs alone.
    expect(loggerError).toHaveBeenCalledTimes(1);
    const [entry, message] = loggerError.mock.calls[0]! as [Record<string, unknown>, string];
    expect(message).toContain('Kafka event emission failed');
    expect(entry).toMatchObject({ eventType: 'posts.post.created', postId: post.id });
    expect((entry.err as Error).message).toBe('kafka down');
  });

  it('soft-deletes own posts, hides them from reads, and emits once', async () => {
    const { repo } = fakeRepo();
    const events = spyEvents();
    const service = new PostsService(
      repo,
      events,
      allowAll,
      new NullMediaChecker(),
      new NullInteractionRealtime(),
    );
    const post = await service.create(AUTHOR, { text: 'gone soon', mediaIds: [], replyToId: null });

    await service.remove(AUTHOR, post.id);
    // Deleted reads as missing: a repeat delete 404s like any absent post.
    await expect(service.remove(AUTHOR, post.id)).rejects.toMatchObject({
      response: { error: { code: 'NOT_FOUND' } },
    });

    await expect(service.getPost(post.id)).rejects.toMatchObject({
      response: { error: { code: 'NOT_FOUND' } },
    });
    expect(events.calls.filter(([type]) => type === 'posts.post.deleted')).toHaveLength(1);
  });

  it('only the author may delete; others get 403 and missing ids 404', async () => {
    const { repo } = fakeRepo();
    const service = new PostsService(
      repo,
      spyEvents(),
      allowAll,
      new NullMediaChecker(),
      new NullInteractionRealtime(),
    );
    const post = await service.create(AUTHOR, { text: 'mine', mediaIds: [], replyToId: null });

    await expect(service.remove(OTHER, post.id)).rejects.toMatchObject({
      response: { error: { code: 'FORBIDDEN' } },
    });
    await expect(
      service.remove(AUTHOR, '00000000-0000-4000-8000-000000000a15'),
    ).rejects.toMatchObject({ response: { error: { code: 'NOT_FOUND' } } });
  });

  it('a failed event emission never fails the committed mutation', async () => {
    const { repo } = fakeRepo();
    const failing: PostsEvents = {
      emit: vi.fn().mockRejectedValue(new Error('kafka down')),
      shutdown: () => Promise.resolve(),
    };
    const service = new PostsService(
      repo,
      failing,
      allowAll,
      new NullMediaChecker(),
      new NullInteractionRealtime(),
    );

    await expect(
      service.create(AUTHOR, { text: 'still works', mediaIds: [], replyToId: null }),
    ).resolves.toMatchObject({ text: 'still works' });
  });
});

// #152: the composed thread read - ancestor walk and bounded reply tree.
describe('PostsService.getThread (#152)', () => {
  const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  /**
   * fakeRepo + a replies() that understands the reply graph: visible
   * children of the node, oldest first, limited like the real keyset page.
   * Reply creation also bumps the parent's replyCount like the real
   * transactional write, so counts-driven flags behave as in production.
   */
  function threadRepo() {
    const base = fakeRepo();
    const childrenOf = (postId: string) =>
      [...base.posts.values()]
        .filter((p) => p.replyToId === postId && !p.deletedAt)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    (base.repo.createPost as (input: {
      authorId: string;
      text: string;
      mediaIds: string[];
      replyToId: string | null;
    }) => Promise<PostRow>) = (input) => {
      const created = row({ id: crypto.randomUUID(), ...input });
      base.posts.set(created.id, created);
      if (input.replyToId) {
        const parent = base.posts.get(input.replyToId);
        if (parent) base.posts.set(parent.id, { ...parent, replyCount: parent.replyCount + 1 });
      }
      return Promise.resolve(created);
    };
    (base.repo.replies as (
      postId: string,
      cursor: string | undefined,
      limit: number,
    ) => Promise<{ items: PostRow[]; nextCursor: string | null }>) = (postId, _cursor, limit) => {
      const all = childrenOf(postId);
      const items = all.slice(0, limit);
      const last = items.at(-1);
      return Promise.resolve({
        items,
        nextCursor: all.length > items.length && last ? `cursor:${last.id}` : null,
      });
    };
    return base;
  }

  const makeService = (repo: ReturnType<typeof threadRepo>['repo']) =>
    new PostsService(
      repo,
      spyEvents(),
      allowAll,
      new NullMediaChecker(),
      new NullInteractionRealtime(),
    );

  /** Chain p1 ← p2 ← … ← pn, created in order so createdAt ascends. */
  async function chain(
    service: PostsService,
    length: number,
    start = 900,
  ): Promise<{ ids: string[]; root: string; newest: string }> {
    let parent: string | null = null;
    const ids: string[] = [];
    for (let i = 0; i < length; i++) {
      const created = await service.create(uid(start + i), {
        text: `chain ${i}`,
        mediaIds: [],
        replyToId: parent,
      });
      ids.push(created.id);
      parent = created.id;
    }
    return { ids, root: ids[0]!, newest: ids.at(-1)! };
  }

  it('404s for missing or deleted focus posts (same semantics as getPost)', async () => {
    const base = threadRepo();
    const service = makeService(base.repo);
    await expect(service.getThread(uid(999), { limit: 20 })).rejects.toMatchObject({
      response: { error: { code: 'NOT_FOUND' } },
    });

    const created = await service.create(uid(901), { text: 'x', mediaIds: [], replyToId: null });
    base.posts.set(created.id, { ...base.posts.get(created.id)!, deletedAt: new Date() });
    await expect(service.getThread(created.id, { limit: 20 })).rejects.toMatchObject({
      response: { error: { code: 'NOT_FOUND' } },
    });
  });

  it('a root focus has no ancestors; replies embed the bounded subtree', async () => {
    const base = threadRepo();
    const service = makeService(base.repo);
    const { root } = await chain(service, 1);

    const r1 = await service.create(uid(910), {
      text: 'first reply',
      mediaIds: [],
      replyToId: root,
    });
    // r1 has two children of its own, the first with a grandchild.
    const r1a = await service.create(uid(911), {
      text: 'nested',
      mediaIds: [],
      replyToId: r1.id,
    });
    await service.create(uid(912), { text: 'nested 2', mediaIds: [], replyToId: r1.id });
    await service.create(uid(913), { text: 'deep', mediaIds: [], replyToId: r1a.id });

    const thread = await service.getThread(root, { limit: 20 });

    expect(thread.ancestors).toEqual([]);
    expect(thread.ancestorsTruncated).toBe(false);
    expect(thread.focus.id).toBe(root);
    expect(thread.replies.map((node) => node.post.id)).toEqual([r1.id]);
    expect(thread.replies[0]?.children.map((node) => node.post.text)).toEqual([
      'nested',
      'nested 2',
    ]);
    expect(thread.replies[0]?.children[0]?.children).toHaveLength(1); // depth 3 embedded
    expect(thread.replies[0]?.childrenTruncated).toBe(false); // counts match embedded
    expect(thread.repliesCursor).toBeNull();
  });

  it('ancestors come back root → parent for a reply focus', async () => {
    const base = threadRepo();
    const service = makeService(base.repo);
    const { ids, root, newest } = await chain(service, 3);

    const thread = await service.getThread(newest, { limit: 20 });

    expect(thread.ancestors.map((p) => p.id)).toEqual([root, ids[1]]);
    expect(thread.focus.id).toBe(newest);
    expect(thread.replies).toEqual([]);
  });

  it('a soft-deleted ancestor ends the walk (descendants see the gap, not older posts)', async () => {
    const base = threadRepo();
    const service = makeService(base.repo);
    const { ids, newest } = await chain(service, 3);
    const mid = ids[1]!;
    base.posts.set(mid, { ...base.posts.get(mid)!, deletedAt: new Date() });

    const thread = await service.getThread(newest, { limit: 20 });

    expect(thread.ancestors).toEqual([]); // the root is behind the gap
    expect(thread.ancestorsTruncated).toBe(false);
  });

  it('a corrupt replyToId cycle terminates instead of looping', async () => {
    const base = threadRepo();
    const service = makeService(base.repo);
    const a = row({ id: uid(930), replyToId: uid(931) });
    const b = row({ id: uid(931), replyToId: uid(930) });
    base.posts.set(a.id, a);
    base.posts.set(b.id, b);

    const thread = await service.getThread(b.id, { limit: 20 });
    expect(thread.ancestors.map((p) => p.id)).toEqual([a.id]);
  });

  it('caps ancestors at 25 and flags truncation only while the visible chain continues', async () => {
    const base = threadRepo();
    const service = makeService(base.repo);
    // 26 posts = focus + exactly 25 ancestors: no truncation.
    const exact = await chain(service, 26, 940);
    const notTruncated = await service.getThread(exact.newest, { limit: 20 });
    expect(notTruncated.ancestors).toHaveLength(25);
    expect(notTruncated.ancestors[0]?.id).toBe(exact.root); // root-most included
    expect(notTruncated.ancestorsTruncated).toBe(false);

    // One more hop: the 26th ancestor exists visibly - flag it.
    const longer = await chain(service, 27, 970);
    const truncated = await service.getThread(longer.newest, { limit: 20 });
    expect(truncated.ancestors).toHaveLength(25);
    expect(truncated.ancestors[0]?.id).toBe(longer.ids[1]); // the true root fell off
    expect(truncated.ancestorsTruncated).toBe(true);

    // A deleted 26th ancestor is a gap, not a truncation.
    base.posts.set(longer.root, {
      ...base.posts.get(longer.root)!,
      deletedAt: new Date(),
    });
    const gapped = await service.getThread(longer.newest, { limit: 20 });
    expect(gapped.ancestorsTruncated).toBe(false);
  });

  it('previews 2 children per node and flags nodes with more (childrenTruncated)', async () => {
    const base = threadRepo();
    const service = makeService(base.repo);
    const { root } = await chain(service, 1, 990);
    const busy = await service.create(uid(991), { text: 'busy', mediaIds: [], replyToId: root });
    for (let i = 0; i < 3; i++) {
      await service.create(uid(992 + i), { text: `kid ${i}`, mediaIds: [], replyToId: busy.id });
    }

    const thread = await service.getThread(root, { limit: 20 });
    const node = thread.replies.find((n) => n.post.id === busy.id)!;

    expect(node.children).toHaveLength(2); // THREAD_CHILDREN_PREVIEW
    expect(node.children.map((n) => n.post.text)).toEqual(['kid 0', 'kid 1']); // oldest first
    expect(node.childrenTruncated).toBe(true); // counts.replies(3) > embedded(2)
  });

  it('depth-3 nodes embed no children but flag whether the conversation continues', async () => {
    const base = threadRepo();
    const service = makeService(base.repo);
    const { root } = await chain(service, 1, 800);
    const d1 = await service.create(uid(801), { text: 'd1', mediaIds: [], replyToId: root });
    const d2 = await service.create(uid(802), { text: 'd2', mediaIds: [], replyToId: d1.id });
    const d3 = await service.create(uid(803), { text: 'd3', mediaIds: [], replyToId: d2.id });
    await service.create(uid(804), { text: 'd4', mediaIds: [], replyToId: d3.id });

    const thread = await service.getThread(root, { limit: 20 });
    const depth3 = thread.replies[0]?.children[0]?.children[0];
    expect(depth3).toBeDefined();
    expect(depth3!.post.id).toBe(d3.id);
    expect(depth3!.children).toEqual([]); // cap reached - no embedding
    expect(depth3!.childrenTruncated).toBe(true); // d4 exists below the cap
  });

  it('respects the top-level limit and surfaces the keyset cursor', async () => {
    const base = threadRepo();
    const service = makeService(base.repo);
    const { root } = await chain(service, 1, 810);
    for (let i = 0; i < 3; i++) {
      await service.create(uid(811 + i), { text: `reply ${i}`, mediaIds: [], replyToId: root });
    }

    const thread = await service.getThread(root, { limit: 2 });
    expect(thread.replies.map((n) => n.post.text)).toEqual(['reply 0', 'reply 1']);
    expect(thread.repliesCursor).toMatch(/^cursor:/); // more top-level pages exist
  });
});

describe('PostsService explicit createdAt (#150)', () => {
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  function serviceWith(spied?: { createPost?: PostsRepository['createPost'] }) {
    const { repo } = fakeRepo(spied);
    const events = spyEvents();
    const svc = new PostsService(
      repo,
      events,
      allowAll,
      new NullMediaChecker(),
      new NullInteractionRealtime(),
    );
    return { svc, events, repo };
  }

  it('stamps the row and the created event with the requested time', async () => {
    const threeDaysAgo = iso(3 * 24 * 60 * 60 * 1000);
    const seen: Date[] = [];
    const { svc, events } = serviceWith({
      createPost: (input) => {
        seen.push((input as { createdAt?: Date }).createdAt!);
        return Promise.resolve(
          row({ id: crypto.randomUUID(), authorId: AUTHOR, createdAt: seen[0] }),
        );
      },
    });

    const post = await svc.create(
      AUTHOR,
      { text: 'last week', mediaIds: [], replyToId: null },
      {
        createdAt: threeDaysAgo,
      },
    );

    expect(seen[0]!.toISOString()).toBe(threeDaysAgo);
    expect(post.createdAt).toBe(threeDaysAgo);
    expect(events.calls[0]![1]).toMatchObject({ createdAt: threeDaysAgo });
  });

  it('rejects future stamps (within skew) and beyond the backdate window', async () => {
    const { svc } = serviceWith();
    await expect(
      svc.create(
        AUTHOR,
        { text: 'from tomorrow', mediaIds: [], replyToId: null },
        {
          createdAt: new Date(Date.now() + BACKDATE_WINDOW_MS).toISOString(),
        },
      ),
    ).rejects.toMatchObject({ response: { error: { code: 'VALIDATION_ERROR' } } });

    await expect(
      svc.create(
        AUTHOR,
        { text: 'too old', mediaIds: [], replyToId: null },
        {
          createdAt: new Date(Date.now() - BACKDATE_WINDOW_MS - 60_000).toISOString(),
        },
      ),
    ).rejects.toMatchObject({ response: { error: { code: 'VALIDATION_ERROR' } } });

    await expect(
      svc.create(
        AUTHOR,
        { text: 'banana time', mediaIds: [], replyToId: null },
        {
          createdAt: 'not-a-date',
        },
      ),
    ).rejects.toMatchObject({ response: { error: { code: 'VALIDATION_ERROR' } } });
  });

  it('accepts a small future skew and leaves the default stamp untouched when absent', async () => {
    const { svc } = serviceWith();
    // 30s ahead: inside the 60s skew allowance (seeder/service clock drift).
    await expect(
      svc.create(
        AUTHOR,
        { text: 'edge skew', mediaIds: [], replyToId: null },
        {
          createdAt: new Date(Date.now() + 30_000).toISOString(),
        },
      ),
    ).resolves.toMatchObject({ text: 'edge skew' });

    const seen: Array<Date | undefined> = [];
    const plain = serviceWith({
      createPost: (input) => {
        seen.push((input as { createdAt?: Date }).createdAt);
        return Promise.resolve(row({ id: crypto.randomUUID(), authorId: AUTHOR }));
      },
    });
    await plain.svc.create(AUTHOR, { text: 'ordinary', mediaIds: [], replyToId: null });
    expect(seen[0]).toBeUndefined(); // the store's now-default applies
  });
});
