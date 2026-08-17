import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { startPostgres } from '@xitter/testing';
import { SocialService } from './social.service.js';
import { SocialRepository, type SocialPrismaClient } from './social.repository.js';
import type { SocialEvents } from './social-events.js';

/**
 * Integration suite (testcontainers Postgres): repository + service rules -
 * follow/block matrices, uniqueness, cascade behaviour, cursor pagination.
 *
 * The generated Prisma client (src/generated/prisma) is gitignored and so is
 * absent from Stryker's sandbox; the suite skips there and runs everywhere
 * else (turbo `test` depends on `generate`).
 */
const hasGeneratedClient = existsSync(join(process.cwd(), 'src/generated/prisma/client.ts'));

describe.skipIf(!hasGeneratedClient)('social integration (testcontainers)', () => {
  let db: SocialPrismaClient;
  let pool: Pool;
  let container: Awaited<ReturnType<typeof startPostgres>>;
  let repo: SocialRepository;
  let service: SocialService;
  const events: SocialEvents & { calls: [string, Record<string, unknown>][] } = {
    calls: [],
    emit(eventType, payload) {
      this.calls.push([eventType, payload]);
      return Promise.resolve();
    },
    shutdown: () => Promise.resolve(),
  };

  const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  beforeAll(async () => {
    const generated = await import('../../generated/prisma/client.js');
    container = await startPostgres('social-test');
    pool = new Pool({ connectionString: container.connectionString });

    // Apply the committed initial migration - the artifact deploy pipelines
    // will use, exercised here on every run.
    const migration = readFileSync(
      join(process.cwd(), 'prisma/migrations/20260816000000_init/migration.sql'),
      'utf8',
    );
    for (const statement of migration.split(/;\s*\n/).filter((s) => s.trim().length > 0)) {
      await pool.query(statement);
    }

    db = new generated.PrismaClient({
      adapter: new PrismaPg({ connectionString: container.connectionString }),
    }) as SocialPrismaClient;
    repo = new SocialRepository(db);
    service = new SocialService(repo, events);
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await container?.stop();
  });

  async function seedProfile(n: number, username: string, displayName = username) {
    const { profile } = await service.ensureProfile({ id: uid(n), username }, { displayName });
    return profile;
  }

  it('creates profiles and is idempotent on re-ensure', async () => {
    const first = await seedProfile(1, 'user1', 'User One');
    expect(first.displayName).toBe('User One');

    const second = await service.ensureProfile({ id: uid(1), username: 'user1' }, {});
    expect(second.created).toBe(false);
    expect(second.profile).toEqual(first);
  });

  it('enforces username uniqueness at the storage layer', async () => {
    await seedProfile(2, 'user2');
    await expect(
      repo.createProfile({ id: uid(3), username: 'user2', displayName: 'Dup', bio: null }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('follow lifecycle: flags, counts, idempotency, events', async () => {
    await seedProfile(10, 'user10');
    await seedProfile(11, 'user11');
    events.calls.length = 0;

    await service.follow(uid(10), uid(11));
    await service.follow(uid(10), uid(11)); // idempotent

    expect(await service.relationship(uid(10), uid(11))).toEqual({
      following: true,
      followedBy: false,
      blocking: false,
      blockedBy: false,
    });
    expect((await service.getProfile(uid(10))).counts).toEqual({ following: 1, followers: 0 });
    expect((await service.getProfile(uid(11))).counts).toEqual({ following: 0, followers: 1 });
    expect(events.calls.filter(([t]) => t === 'social.follow.created')).toHaveLength(1);

    await service.unfollow(uid(10), uid(11));
    await service.unfollow(uid(10), uid(11)); // idempotent
    expect(await service.relationship(uid(10), uid(11))).toMatchObject({ following: false });
    expect(events.calls.filter(([t]) => t === 'social.follow.deleted')).toHaveLength(1);
  });

  it('rejects follows when blocked in either direction', async () => {
    await seedProfile(20, 'user20');
    await seedProfile(21, 'user21');
    await service.block(uid(20), uid(21));

    await expect(service.follow(uid(20), uid(21))).rejects.toMatchObject({
      response: { error: { code: 'FORBIDDEN' } },
    });
    await expect(service.follow(uid(21), uid(20))).rejects.toMatchObject({
      response: { error: { code: 'FORBIDDEN' } },
    });

    await service.unblock(uid(20), uid(21));
    await expect(service.follow(uid(21), uid(20))).resolves.toBeUndefined();
  });

  it('blocking removes existing follows in both directions', async () => {
    await seedProfile(30, 'user30');
    await seedProfile(31, 'user31');
    await service.follow(uid(30), uid(31));
    await service.follow(uid(31), uid(30));
    events.calls.length = 0;

    await service.block(uid(30), uid(31));

    expect(await service.relationship(uid(30), uid(31))).toEqual({
      following: false,
      followedBy: false,
      blocking: true,
      blockedBy: false,
    });
    expect(events.calls.filter(([t]) => t === 'social.follow.deleted')).toHaveLength(2);

    // Follows stay gone while blocked, and blocking again is a no-op.
    await service.block(uid(30), uid(31));
    expect(events.calls.filter(([t]) => t === 'social.block.created')).toHaveLength(1);
  });

  it('paginates following and followers without gaps or duplicates', async () => {
    await seedProfile(40, 'user40');
    for (let n = 41; n <= 52; n++) {
      await seedProfile(n, `user${n}`);
      await service.follow(uid(40), uid(n)); // user40 follows 12 users
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await service.following(uid(40), { cursor, limit: 5 });
      seen.push(...page.items.map((p) => p.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);

    const followers = await service.followers(uid(45), { limit: 5 });
    expect(followers.items.map((p) => p.id)).toEqual([uid(40)]);
  });

  it('deleting a profile cascades its follows and blocks', async () => {
    await seedProfile(60, 'user60');
    await seedProfile(61, 'user61');
    await service.follow(uid(60), uid(61));
    await service.follow(uid(61), uid(60));
    await service.block(uid(60), uid(61));

    await db.profile.delete({ where: { id: uid(60) } });

    expect(await repo.followerIds(uid(61))).toEqual([]);
    expect(await repo.blockedIds(uid(61))).toEqual([]);
  });

  it('internal endpoints: follower ids, blocked ids, pair relationship', async () => {
    await seedProfile(70, 'user70');
    await seedProfile(71, 'user71');
    await seedProfile(72, 'user72');
    await service.follow(uid(71), uid(70));
    await service.follow(uid(72), uid(70));
    expect(await service.followerIds(uid(70))).toEqual([uid(71), uid(72)]);

    // Blocking user72 also removes their follow of user70 (block semantics).
    await service.block(uid(70), uid(72));

    expect(await service.followerIds(uid(70))).toEqual([uid(71)]);
    expect(await service.blockedIds(uid(70))).toEqual([uid(72)]);
    expect(await service.relationshipPair(uid(72), uid(70))).toMatchObject({ blockedBy: true });
  });

  it('reseed truncates profiles and the graph', async () => {
    await seedProfile(80, 'user80');
    await seedProfile(81, 'user81');
    await service.follow(uid(80), uid(81));

    await service.reseed();

    await expect(service.getProfile(uid(80))).rejects.toMatchObject({
      response: { error: { code: 'NOT_FOUND' } },
    });
    expect(await repo.followerIds(uid(81))).toEqual([]);
  });

  it('self-target mutations and unknown targets are rejected', async () => {
    await seedProfile(90, 'user90');
    await expect(service.follow(uid(90), uid(90))).rejects.toMatchObject({
      response: { error: { code: 'VALIDATION_ERROR' } },
    });
    await expect(service.follow(uid(90), uid(99))).rejects.toMatchObject({
      response: { error: { code: 'NOT_FOUND' } },
    });
  });
});
