import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { startPostgres } from '@xitter/testing';
import { POST_TEXT_MAX } from '@xitter/api-contracts';
import type { MediaAsset } from '@xitter/api-contracts';
import { NullMediaChecker, type MediaChecker } from './media-checker.js';
import { PostsService } from './posts.service.js';
import { PostsRepository, type PostsPrismaClient } from './posts.repository.js';
import type { PostsEvents } from './posts-events.js';
import type { RelationshipChecker } from './relationship-checker.js';

/**
 * Integration suite (testcontainers Postgres): create/reply/delete flows,
 * validation limits (513 chars rejected), soft-delete hiding, cursor
 * pagination, and the counts read-model.
 *
 * The generated Prisma client (src/generated/prisma) is gitignored and so is
 * absent from Stryker's sandbox; the suite skips there and runs everywhere
 * else (turbo `test` depends on `generate`).
 */
const hasGeneratedClient = existsSync(join(process.cwd(), 'src/generated/prisma/client.ts'));

describe.skipIf(!hasGeneratedClient)('posts integration (testcontainers)', () => {
  let db: PostsPrismaClient;
  let pool: Pool;
  let container: Awaited<ReturnType<typeof startPostgres>>;
  let repo: PostsRepository;
  const events: PostsEvents & { calls: [string, Record<string, unknown>][] } = {
    calls: [],
    emit(eventType, payload) {
      this.calls.push([eventType, payload]);
      return Promise.resolve();
    },
    shutdown: () => Promise.resolve(),
  };

  const uid = (n: string) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  beforeAll(async () => {
    const generated = await import('../generated/prisma/client.js');
    container = await startPostgres('posts-test');
    pool = new Pool({ connectionString: container.connectionString });

    // Apply the committed migrations in order - the artifacts deploy
    // pipelines will use, exercised here on every run.
    for (const dir of readdirSync(join(process.cwd(), 'prisma/migrations')).sort()) {
      const migration = readFileSync(
        join(process.cwd(), 'prisma/migrations', dir, 'migration.sql'),
        'utf8',
      );
      for (const statement of migration.split(/;\s*\n/).filter((s) => s.trim().length > 0)) {
        await pool.query(statement);
      }
    }

    db = new generated.PrismaClient({
      adapter: new PrismaPg({ connectionString: container.connectionString }),
    }) as PostsPrismaClient;
    repo = new PostsRepository(db);
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await container?.stop();
  });

  /** Service wired with an in-memory block table the tests flip per case. */
  function makeService(blocks: Set<string> = new Set()): PostsService {
    const checker: RelationshipChecker = {
      blockedEitherWay: (a, b) =>
        Promise.resolve(blocks.has(`${a}|${b}`) || blocks.has(`${b}|${a}`)),
    };
    return new PostsService(repo, events, checker, new NullMediaChecker());
  }

  it('creates posts with zero-initialised counts', async () => {
    const service = makeService();
    const post = await service.create(uid('a1'), {
      text: 'top level',
      mediaIds: [],
      replyToId: null,
    });
    expect(post.counts).toEqual({ replies: 0, likes: 0, reposts: 0 });
    expect(post.createdAt).toBeTruthy();
  });

  it(`rejects ${POST_TEXT_MAX + 1}-character text at the contract boundary`, async () => {
    const service = makeService();
    await expect(
      service.create(uid('a2'), {
        text: 'x'.repeat(POST_TEXT_MAX + 1),
        mediaIds: [],
        replyToId: null,
      }),
    ).rejects.toMatchObject({ response: { error: { code: 'VALIDATION_ERROR' } } });
  });

  it('reply flow: parents gain reply counts, threads list chronologically', async () => {
    const service = makeService();
    const parent = await service.create(uid('a3'), {
      text: 'ask me anything',
      mediaIds: [],
      replyToId: null,
    });

    const r1 = await service.create(uid('a4'), {
      text: 'first!',
      mediaIds: [],
      replyToId: parent.id,
    });
    // A gap guarantees the chronological ordering is from createdAt, not luck.
    await new Promise((r) => setTimeout(r, 20));
    const r2 = await service.create(uid('a5'), {
      text: 'second',
      mediaIds: [],
      replyToId: parent.id,
    });

    expect((await service.getPost(parent.id)).counts).toMatchObject({ replies: 2 });
    const thread = await service.postReplies(parent.id, { limit: 10 });
    expect(thread.items.map((p) => p.id)).toEqual([r1.id, r2.id]);
  });

  it('blocks replies when a block exists in either direction', async () => {
    const blocks = new Set<string>();
    const service = makeService(blocks);
    const parent = await service.create(uid('a6'), {
      text: 'protected',
      mediaIds: [],
      replyToId: null,
    });

    blocks.add(`${uid('a7')}|${uid('a6')}`);
    await expect(
      service.create(uid('a7'), { text: 'nope', mediaIds: [], replyToId: parent.id }),
    ).rejects.toMatchObject({ response: { error: { code: 'FORBIDDEN' } } });

    // The blocker replying to their own post needs no social check - allowed.
    await expect(
      service.create(uid('a6'), { text: 'self reply', mediaIds: [], replyToId: parent.id }),
    ).resolves.toMatchObject({ replyToId: parent.id });
  });

  it('soft delete hides the post everywhere and decrements parent reply counts', async () => {
    const service = makeService();
    const parent = await service.create(uid('a8'), {
      text: 'parent',
      mediaIds: [],
      replyToId: null,
    });
    const reply = await service.create(uid('a9'), {
      text: 'reply',
      mediaIds: [],
      replyToId: parent.id,
    });
    expect((await service.getPost(parent.id)).counts.replies).toBe(1);

    await service.remove(uid('a9'), reply.id);

    await expect(service.getPost(reply.id)).rejects.toMatchObject({
      response: { error: { code: 'NOT_FOUND' } },
    });
    await expect(service.postReplies(parent.id, { limit: 10 })).resolves.toMatchObject({
      items: [],
    });
    expect((await service.getPost(parent.id)).counts.replies).toBe(0);
    // Reply rows survive soft-deleted for #8's interaction accounting.
    expect(await db.post.findUnique({ where: { id: reply.id } })).toMatchObject({
      deletedAt: expect.any(Date),
    });
  });

  it('only the author can delete; missing and already-deleted ids 404', async () => {
    const service = makeService();
    const post = await service.create(uid('b1'), { text: 'mine', mediaIds: [], replyToId: null });

    await expect(service.remove(uid('b2'), post.id)).rejects.toMatchObject({
      response: { error: { code: 'FORBIDDEN' } },
    });
    await service.remove(uid('b1'), post.id);
    await expect(service.remove(uid('b1'), post.id)).rejects.toMatchObject({
      response: { error: { code: 'NOT_FOUND' } },
    });
  });

  it('paginates author timelines newest-first without gaps or duplicates', async () => {
    const service = makeService();
    const author = uid('c1');
    for (let n = 0; n < 12; n++) {
      await service.create(author, { text: `post ${n}`, mediaIds: [], replyToId: null });
      await new Promise((r) => setTimeout(r, 5)); // distinct keyset positions
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await service.userPosts(author, { cursor, limit: 5 });
      seen.push(...page.items.map((p) => p.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
    // Newest first: page 1's first item is the last-created post.
    const firstPage = await service.userPosts(author, { limit: 5 });
    expect(firstPage.items[0]?.text).toBe('post 11');
  });

  it('deleted posts vanish from author timelines', async () => {
    const service = makeService();
    const author = uid('d1');
    const keep = await service.create(author, { text: 'keep', mediaIds: [], replyToId: null });
    const drop = await service.create(author, { text: 'drop', mediaIds: [], replyToId: null });
    await service.remove(author, drop.id);

    const page = await service.userPosts(author, { limit: 10 });
    expect(page.items.map((p) => p.id)).toEqual([keep.id]);
  });

  it('rejects forged cursors with 400 instead of walking or crashing', async () => {
    const service = makeService();
    const forged = Buffer.from(JSON.stringify({ createdAt: 'banana', id: 'x' }), 'utf8').toString(
      'base64url',
    );
    await expect(service.userPosts(uid('e1'), { cursor: forged, limit: 5 })).rejects.toMatchObject({
      response: { error: { code: 'VALIDATION_ERROR' } },
    });
  });

  it('attaches ready media (snapshot survives reads) and rejects non-ready ids', async () => {
    const ready: MediaAsset = {
      id: uid('f3'),
      ownerId: uid('f2'),
      status: 'ready',
      variants: [
        {
          kind: 'thumb',
          objectKey: `${uid('f2')}/${uid('f3')}/thumb.png`,
          mimeType: 'image/png',
          bytes: 100,
          width: 320,
          height: 200,
          url: `/media/${uid('f2')}/${uid('f3')}/thumb.png`,
        },
      ],
      createdAt: '2026-08-18T00:00:00.000Z',
    };
    const checker: MediaChecker = {
      resolveForAttach: (_owner, ids) =>
        Promise.resolve(ids.map((id) => (id === ready.id ? ready : { ...ready, id, status: 'pending' as const }))),
    };
    const service = new PostsService(repo, events, { blockedEitherWay: () => Promise.resolve(false) }, checker);

    const post = await service.create(uid('f2'), {
      text: 'with media',
      mediaIds: [ready.id],
      replyToId: null,
    });
    // Snapshot rendered on reads without a media round-trip.
    expect((await service.getPost(post.id)).media).toEqual([ready]);

    // A still-pending asset is refused with the offending id in details.
    await expect(
      service.create(uid('f2'), { text: 'too early', mediaIds: [uid('f4')], replyToId: null }),
    ).rejects.toMatchObject({
      response: {
        error: expect.objectContaining({
          code: 'VALIDATION_ERROR',
          details: { invalidMediaIds: [uid('f4')] },
        }),
      },
    });
  });

  it('reseed truncates posts and interactions', async () => {
    const service = makeService();
    const post = await service.create(uid('f1'), {
      text: 'transient',
      mediaIds: [],
      replyToId: null,
    });
    await db.interaction.create({
      data: { kind: 'like', postId: post.id, userId: uid('f2') },
    });

    await service.reseed();

    expect(await db.post.count()).toBe(0);
    expect(await db.interaction.count()).toBe(0);
  });
});
