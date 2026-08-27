import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { startPostgres } from '@xitter/testing';
import type { FeedEntryInput, Post, Profile } from '@xitter/api-contracts';
import { FeedService } from './feed.service.js';
import { CheckpointRepository } from './checkpoint.repository.js';
import { FeedRepository, type FeedPrismaClient } from './feed.repository.js';
import type { ContentHydrator } from './content-hydrator.js';
import type { FeedRealtime } from './feed-realtime.js';

/**
 * Integration suite (testcontainers Postgres): the materialised feed end to
 * end - bulk upsert correctness, idempotent replay against the real natural
 * key, newest-first cursor pagination, blocked-author filtering, and entry
 * removal on delete/unfollow. Hydration runs against an in-memory store so
 * the suite pins feed-owned behaviour only (the e2e suite covers the full
 * service path). Skips in Stryker's sandbox (no generated Prisma client).
 */
const hasGeneratedClient = existsSync(join(process.cwd(), 'src/generated/prisma/client.ts'));

const OWNER = '00000000-0000-4000-8000-00000000d001';
const FOLLOWEE = '00000000-0000-4000-8000-00000000d002';
const BLOCKED_AUTHOR = '00000000-0000-4000-8000-00000000d003';

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`;

describe.skipIf(!hasGeneratedClient)('feed integration (testcontainers postgres)', () => {
  let db: FeedPrismaClient;
  let pool: Pool;
  let container: Awaited<ReturnType<typeof startPostgres>>;
  let repo: FeedRepository;
  let service: FeedService;
  let hydrator: ContentHydrator & {
    store: { posts: Map<string, Post>; profiles: Map<string, Profile>; blocked: Set<string> };
  };
  let notified: string[][];

  beforeAll(async () => {
    const generated = await import('../generated/prisma/client.js');
    container = await startPostgres('feed-test');
    pool = new Pool({ connectionString: container.connectionString });

    // Apply the committed migrations in order - the artifacts deploy
    // pipelines will use, exercised here on every run.
    for (const dir of readdirSync(join(process.cwd(), 'prisma/migrations'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()) {
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
    }) as FeedPrismaClient;
    repo = new FeedRepository(db);

    const posts = new Map<string, Post>();
    const profiles = new Map<string, Profile>();
    const blocked = new Set<string>();
    hydrator = {
      posts: (ids) =>
        Promise.resolve(
          new Map(ids.filter((id) => posts.has(id)).map((id) => [id, posts.get(id)!])),
        ),
      profiles: (ids) =>
        Promise.resolve(
          new Map(ids.filter((id) => profiles.has(id)).map((id) => [id, profiles.get(id)!])),
        ),
      blockedAuthorIds: (userId) => Promise.resolve(userId === OWNER ? [...blocked] : []),
      store: { posts, profiles, blocked },
    };
    notified = [];
    const realtime: FeedRealtime = {
      notify: (userIds) => {
        notified.push(userIds);
        return Promise.resolve();
      },
    };
    service = new FeedService(repo, hydrator, realtime, new CheckpointRepository(db));
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await container?.stop();
  });

  const at = (h: number) => new Date(`2026-08-18T${String(h).padStart(2, '0')}:00:00.000Z`);

  function seedPost(id: string, authorId: string, createdAt: Date) {
    const post: Post = {
      id,
      authorId,
      text: `post ${id}`,
      media: [],
      replyToId: null,
      repostOfId: null,
      counts: { replies: 0, likes: 0, reposts: 0 },
      createdAt: createdAt.toISOString(),
      deletedAt: null,
    };
    hydrator.store.posts.set(id, post);
    hydrator.store.profiles.set(
      authorId,
      hydrator.store.profiles.get(authorId) ?? {
        id: authorId,
        username: `user${authorId.slice(-4)}`,
        displayName: `User ${authorId.slice(-4)}`,
        bio: null,
        createdAt: new Date(0).toISOString(),
      },
    );
    return post;
  }

  function entryInput(
    userId: string,
    postId: string,
    authorId: string,
    createdAt: Date,
  ): FeedEntryInput {
    return {
      userId,
      postId,
      authorId,
      reason: 'post',
      repostedById: null,
      postCreatedAt: createdAt.toISOString(),
    };
  }

  function repostInput(
    userId: string,
    postId: string,
    reposterId: string,
    createdAt: Date,
  ): FeedEntryInput {
    return {
      userId,
      postId,
      authorId: reposterId,
      reason: 'repost',
      repostedById: reposterId,
      postCreatedAt: createdAt.toISOString(),
    };
  }

  it('materialises entries and notifies the affected users', async () => {
    seedPost(uid('e101'), FOLLOWEE, at(10));
    seedPost(uid('e102'), OWNER, at(11));

    const result = await service.upsertEntries([
      entryInput(OWNER, uid('e101'), FOLLOWEE, at(10)),
      entryInput(OWNER, uid('e102'), OWNER, at(11)),
    ]);

    expect(result).toEqual({ inserted: 2 });
    expect(notified).toEqual([[OWNER]]);
  });

  it('is idempotent on event replay (natural-key upsert)', async () => {
    const replay = await service.upsertEntries([
      entryInput(OWNER, uid('e101'), FOLLOWEE, at(10)),
      entryInput(OWNER, uid('e102'), OWNER, at(11)),
    ]);

    expect(replay).toEqual({ inserted: 0 });
    // And no spurious notification fired for the replay.
    expect(notified).toHaveLength(1);

    const rows = await db.feedEntry.count({ where: { userId: OWNER } });
    expect(rows).toBe(2);
  });

  it('pages newest-first with a stable cursor walk', async () => {
    for (let h = 12; h < 16; h++) {
      const id = uid(`e11${h}`);
      seedPost(id, FOLLOWEE, at(h));
      await service.upsertEntries([entryInput(OWNER, id, FOLLOWEE, at(h))]);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await service.getFeed(OWNER, { limit: 2, cursor });
      seen.push(...page.items.map((item) => item.post.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(seen).toHaveLength(6);
    const times = seen.map((id) => hydrator.store.posts.get(id)!.createdAt);
    expect([...times].sort().reverse()).toEqual(times); // strictly newest first
  });

  it('excludes blocked authors from reads while their entries persist', async () => {
    const blockedPost = uid('e201');
    seedPost(blockedPost, BLOCKED_AUTHOR, at(20));
    await service.upsertEntries([entryInput(OWNER, blockedPost, BLOCKED_AUTHOR, at(20))]);

    hydrator.store.blocked.add(BLOCKED_AUTHOR);
    const page = await service.getFeed(OWNER, { limit: 50 });

    expect(page.items.some((item) => item.post.authorId === BLOCKED_AUTHOR)).toBe(false);
    // Blocks are a read-time filter only (product decision, spec 04): the
    // row stays for the nightly reset to reclaim.
    expect(await db.feedEntry.count({ where: { userId: OWNER, authorId: BLOCKED_AUTHOR } })).toBe(
      1,
    );
  });

  it('drops deleted posts during hydration and refills from older entries', async () => {
    const fresh = await db.feedEntry.deleteMany({ where: { userId: OWNER } });
    expect(fresh.count).toBeGreaterThan(0); // precondition: prior entries cleared

    const newest = uid('e301');
    const older1 = uid('e302');
    const older2 = uid('e303');
    seedPost(older1, FOLLOWEE, at(1));
    seedPost(older2, FOLLOWEE, at(2));
    // newest deliberately NOT in the posts store = deleted before read
    await service.upsertEntries([
      entryInput(OWNER, newest, FOLLOWEE, at(3)),
      entryInput(OWNER, older2, FOLLOWEE, at(2)),
      entryInput(OWNER, older1, FOLLOWEE, at(1)),
    ]);

    const page = await service.getFeed(OWNER, { limit: 2 });

    expect(page.items.map((item) => item.post.id)).toEqual([older2, older1]);
    expect(page.nextCursor).toBeNull(); // the deleted entry consumed no page slot
  });

  it('removes entries everywhere on post deletion', async () => {
    const postId = uid('e401');
    seedPost(postId, FOLLOWEE, at(5));
    await service.upsertEntries([
      entryInput(OWNER, postId, FOLLOWEE, at(5)),
      entryInput(FOLLOWEE, postId, FOLLOWEE, at(5)),
    ]);

    const result = await service.deletePostEntries(postId);

    expect(result).toEqual({ deleted: 2 });
    expect(await db.feedEntry.count({ where: { postId } })).toBe(0);
  });

  it('keeps two reposters of one post distinct and replays idempotently (#8 key)', async () => {
    const postId = uid('e411');
    seedPost(postId, FOLLOWEE, at(7));
    await service.upsertEntries([entryInput(OWNER, postId, FOLLOWEE, at(7))]);

    // Two different users repost the same post into OWNER's feed.
    const first = await service.upsertEntries([repostInput(OWNER, postId, FOLLOWEE, at(8))]);
    const second = await service.upsertEntries([repostInput(OWNER, postId, BLOCKED_AUTHOR, at(9))]);

    // Both repost entries land - the old (userId, postId, reason) key would
    // have collided and skip-dropped the second.
    expect(first).toEqual({ inserted: 1 });
    expect(second).toEqual({ inserted: 1 });
    expect(await db.feedEntry.count({ where: { userId: OWNER, postId } })).toBe(3);

    // Event replay converges: nothing new, no spurious notify.
    const before = notified.length;
    const replay = await service.upsertEntries([repostInput(OWNER, postId, FOLLOWEE, at(8))]);
    expect(replay).toEqual({ inserted: 0 });
    expect(notified.length).toBe(before);

    // Undo removes only that reposter's entry.
    const undo = await service.deleteRepostEntries(postId, FOLLOWEE);
    expect(undo).toEqual({ deleted: 1 });
    expect(await db.feedEntry.count({ where: { userId: OWNER, postId } })).toBe(2);
    expect(
      await db.feedEntry.count({ where: { userId: OWNER, postId, repostedById: BLOCKED_AUTHOR } }),
    ).toBe(1);
  });

  it('removes only the unfollowed author from the user feed', async () => {
    await db.feedEntry.deleteMany({ where: { userId: OWNER } });
    const mine = uid('e501');
    const theirs = uid('e502');
    seedPost(mine, OWNER, at(6));
    seedPost(theirs, FOLLOWEE, at(6));
    await service.upsertEntries([
      entryInput(OWNER, mine, OWNER, at(6)),
      entryInput(OWNER, theirs, FOLLOWEE, at(6)),
    ]);

    const result = await service.deleteAuthorEntries(OWNER, FOLLOWEE);

    expect(result).toEqual({ deleted: 1 });
    const page = await service.getFeed(OWNER, { limit: 50 });
    expect(page.items.map((item) => item.post.id)).toContain(mine);
    expect(page.items.map((item) => item.post.id)).not.toContain(theirs);
  });

  it('rejects malformed cursors with the 400 envelope', async () => {
    await expect(service.getFeed(OWNER, { limit: 20, cursor: 'garbage' })).rejects.toMatchObject({
      response: { error: { code: 'VALIDATION_ERROR' } },
    });
  });

  it('resets a whole feed (reset job path)', async () => {
    const result = await service.resetUser(OWNER);
    expect(result.deleted).toBeGreaterThan(0);
    expect(await db.feedEntry.count({ where: { userId: OWNER } })).toBe(0);
  });

  it('persists fanout resume positions against the real schema and reseeds them away (#149)', async () => {
    const input = (offset: number, topicPartition = 'xitter.posts.v1:0') => ({
      consumerKey: 'xitter-fanout-worker-it',
      topicPartition,
      offset,
      eventId: `e-${offset}`,
      eventAt: at(7).toISOString(),
    });

    await service.reportCheckpoint(input(10));
    await service.reportCheckpoint(input(42)); // redelivery advances the same row
    await service.reportCheckpoint(input(7, 'xitter.social.v1:1'));

    const positions = await service.checkpointPositions('xitter-fanout-worker-it');
    expect(positions.map((p) => p.topicPartition).sort()).toEqual([
      'xitter.posts.v1:0',
      'xitter.social.v1:1',
    ]);
    expect(positions.find((p) => p.topicPartition === 'xitter.posts.v1:0')).toMatchObject({
      offset: 42,
      eventId: 'e-42',
    });

    // The nightly reset wipes both stores: entries and the cursor into them.
    const reseed = await service.reseed();
    expect(reseed.deleted).toBeGreaterThanOrEqual(2); // at least the checkpoint rows
    await expect(service.checkpointPositions('xitter-fanout-worker-it')).resolves.toEqual([]);
    expect(await db.feedEntry.count()).toBe(0);
  });
});
