import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { startPostgres } from '@xitter/testing';
import { NullInteractionRealtime } from './interaction-realtime.js';
import { NullMediaChecker } from './media-checker.js';
import { PostsService } from './posts.service.js';
import { PostsRepository, type PostsPrismaClient } from './posts.repository.js';
import type { PostsEvents } from './posts-events.js';
import type { RelationshipChecker } from './relationship-checker.js';

/**
 * Interaction suite (#8) against testcontainers Postgres: CRUD + undo,
 * natural-key idempotency, concurrent-like count correctness (the
 * transactional read-model), block rejection for every kind, bookmark
 * privacy + soft-delete exclusion, and viewer-state derivation. Skips in
 * Stryker's sandbox (no generated Prisma client), like the posts suite.
 */
const hasGeneratedClient = existsSync(join(process.cwd(), 'src/generated/prisma/client.ts'));

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`;

describe.skipIf(!hasGeneratedClient)('interactions integration (testcontainers)', () => {
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

  beforeAll(async () => {
    const generated = await import('../generated/prisma/client.js');
    container = await startPostgres('posts-interactions-test');
    pool = new Pool({ connectionString: container.connectionString });

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
      // Prisma's 2s/5s transaction defaults assume a quiet host; CI runs
      // several container suites in parallel on 2-core runners and pool
      // acquisition starves past them (P2028) before any query is at fault.
      transactionOptions: { maxWait: 20_000, timeout: 60_000 },
    }) as PostsPrismaClient;
    repo = new PostsRepository(db);
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await container?.stop();
  });

  function makeService(blocks: Set<string> = new Set()) {
    const checker: RelationshipChecker = {
      blockedEitherWay: (a, b) =>
        Promise.resolve(blocks.has(`${a}|${b}`) || blocks.has(`${b}|${a}`)),
    };
    return new PostsService(
      repo,
      events,
      checker,
      new NullMediaChecker(),
      new NullInteractionRealtime(),
    );
  }

  async function seedPost(service: PostsService, author: string, text: string) {
    return service.create(author, { text, mediaIds: [], replyToId: null });
  }

  it('creates and undoes all three kinds with exact counts', async () => {
    const service = makeService();
    const author = uid('i001');
    const liker = uid('i002');
    const post = await seedPost(service, author, 'interaction target');

    await service.interact(liker, post.id, 'like');
    await service.interact(liker, post.id, 'bookmark');
    await service.interact(liker, post.id, 'repost');
    // Bookmarks are private annotations: no public count.
    expect((await service.getPost(post.id)).counts).toEqual({ replies: 0, likes: 1, reposts: 1 });

    await service.removeInteraction(liker, post.id, 'like');
    await service.removeInteraction(liker, post.id, 'repost');
    expect((await service.getPost(post.id)).counts).toEqual({ replies: 0, likes: 0, reposts: 0 });

    // The bookmark survives (only its own undo removes it).
    const state = await service.viewerState(liker, [post.id]);
    expect(state).toEqual([{ postId: post.id, liked: false, reposted: false, bookmarked: true }]);

    await service.removeInteraction(liker, post.id, 'bookmark');
    const stateAfter = await service.viewerState(liker, [post.id]);
    expect(stateAfter[0]!.bookmarked).toBe(false);
  });

  it('is idempotent: repeat creates neither recount nor re-emit', async () => {
    const service = makeService();
    const author = uid('i011');
    const liker = uid('i012');
    const post = await seedPost(service, author, 'idempotency target');

    const first = await service.interact(liker, post.id, 'like');
    events.calls.length = 0;
    const second = await service.interact(liker, post.id, 'like');

    expect((await service.getPost(post.id)).counts.likes).toBe(1);
    expect(events.calls).toHaveLength(0); // no second interaction.created
    expect(second).toEqual(first); // resolves to the stored row

    // Undo twice: the second is a silent 204 (no negative counts).
    await service.removeInteraction(liker, post.id, 'like');
    await service.removeInteraction(liker, post.id, 'like');
    expect((await service.getPost(post.id)).counts.likes).toBe(0);
    expect(await db.interaction.count({ where: { postId: post.id } })).toBe(0);
  });

  it('keeps counts exact under concurrent likes (transactional read-model)', async () => {
    const service = makeService();
    const author = uid('i021');
    const post = await seedPost(service, author, 'concurrent target');

    // 12 distinct users race to like; each may also double-fire the same
    // create (client retry) - the natural key + one transaction must land
    // exactly 12 rows and a count of exactly 12.
    const likers = Array.from({ length: 12 }, (_, n) => uid(`i03${String(n).padStart(2, '0')}`));
    await Promise.all(
      likers.flatMap((liker) => [
        service.interact(liker, post.id, 'like'),
        service.interact(liker, post.id, 'like'),
      ]),
    );

    expect(await db.interaction.count({ where: { postId: post.id, kind: 'like' } })).toBe(12);
    expect((await service.getPost(post.id)).counts.likes).toBe(12);

    // Concurrent undos of half of them land exactly 6.
    await Promise.all(
      likers.slice(0, 6).map((liker) => service.removeInteraction(liker, post.id, 'like')),
    );
    expect((await service.getPost(post.id)).counts.likes).toBe(6);
  });

  it('rejects every interaction kind when a block exists either way', async () => {
    const blocks = new Set<string>();
    const service = makeService(blocks);
    const author = uid('i041');
    const blocked = uid('i042');
    const post = await seedPost(service, author, 'protected target');

    blocks.add(`${blocked}|${author}`);
    for (const kind of ['like', 'bookmark', 'repost'] as const) {
      await expect(service.interact(blocked, post.id, kind)).rejects.toMatchObject({
        response: { error: { code: 'FORBIDDEN' } },
      });
    }
    // Replies regression: the same block refuses a reply from the same user.
    await expect(
      service.create(blocked, { text: 'nope', mediaIds: [], replyToId: post.id }),
    ).rejects.toMatchObject({ response: { error: { code: 'FORBIDDEN' } } });
    expect((await service.getPost(post.id)).counts).toEqual({ replies: 0, likes: 0, reposts: 0 });

    // Undo stays possible for the blocked user's OWN earlier interactions
    // (cleanup, not engagement) - here there is simply nothing to undo: 204.
    await expect(service.removeInteraction(blocked, post.id, 'like')).resolves.toBeUndefined();
  });

  it('allows self-interactions (own post) without a social check', async () => {
    const service = makeService();
    const author = uid('i051');
    const post = await seedPost(service, author, 'self target');

    await expect(service.interact(author, post.id, 'repost')).resolves.toMatchObject({
      kind: 'repost',
    });
    expect((await service.getPost(post.id)).counts.reposts).toBe(1);
  });

  it('interacts against the ORIGINAL post: reposts are interactions, not posts', async () => {
    const service = makeService();
    const author = uid('i061');
    const post = await seedPost(service, author, 'repost target');

    // A repost creates no post row - there is nothing to chain a repost of.
    await service.interact(uid('i062'), post.id, 'repost');
    expect(await db.post.count({ where: { authorId: uid('i061') } })).toBe(1);
    expect((await service.getPost(post.id)).counts.reposts).toBe(1);
  });

  it('lists bookmarks newest-first, privately per caller, excluding deleted posts', async () => {
    const service = makeService();
    const author = uid('i071');
    const keeper = await seedPost(service, author, 'keep me');
    await new Promise((r) => setTimeout(r, 20));
    const doomed = await seedPost(service, author, 'doom me');

    const caller = uid('i072');
    await service.interact(caller, doomed.id, 'bookmark');
    await service.interact(caller, keeper.id, 'bookmark');
    await service.removeInteraction(caller, doomed.id, 'bookmark');

    const page = await service.bookmarks(caller, { limit: 10 });
    expect(page.items.map((p) => p.id)).toEqual([keeper.id]);

    // Another caller's bookmarks are invisible - their page is their own.
    const other = uid('i073');
    const otherPage = await service.bookmarks(other, { limit: 10 });
    expect(otherPage.items).toEqual([]);

    // Soft-deleting the bookmarked post drops it from the list.
    await service.remove(author, keeper.id);
    const afterDelete = await service.bookmarks(caller, { limit: 10 });
    expect(afterDelete.items).toEqual([]);
  });

  it('derives viewer state from interaction rows only', async () => {
    const service = makeService();
    const author = uid('i081');
    const viewer = uid('i082');
    const liked = await seedPost(service, author, 'liked');
    const reposted = await seedPost(service, author, 'reposted');
    const untouched = await seedPost(service, author, 'untouched');

    await service.interact(viewer, liked.id, 'like');
    await service.interact(viewer, reposted.id, 'repost');
    await service.interact(viewer, liked.id, 'bookmark');

    const state = await service.viewerState(viewer, [liked.id, reposted.id, untouched.id]);
    expect(state).toEqual([
      { postId: liked.id, liked: true, reposted: false, bookmarked: true },
      { postId: reposted.id, liked: false, reposted: true, bookmarked: false },
      { postId: untouched.id, liked: false, reposted: false, bookmarked: false },
    ]);
  });

  it('emits interaction.created/deleted with full payloads', async () => {
    const service = makeService();
    const author = uid('i091');
    const liker = uid('i092');
    const post = await seedPost(service, author, 'event target');
    events.calls.length = 0;

    await service.interact(liker, post.id, 'like');
    await service.removeInteraction(liker, post.id, 'like');

    const created = events.calls.find(([type]) => type === 'posts.interaction.created');
    expect(created?.[1]).toMatchObject({
      interactionId: expect.any(String),
      kind: 'like',
      postId: post.id,
      userId: liker,
      createdAt: expect.any(String),
    });
    const deleted = events.calls.find(([type]) => type === 'posts.interaction.deleted');
    expect(deleted?.[1]).toMatchObject({
      kind: 'like',
      postId: post.id,
      userId: liker,
      deletedAt: expect.any(String),
    });
  });
});
