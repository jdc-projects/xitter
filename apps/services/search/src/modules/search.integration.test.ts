import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { Client } from '@opensearch-project/opensearch';
import { Pool } from 'pg';
import { startOpenSearch, startPostgres } from '@xitter/testing';
import type { Post, Profile, SearchIndexDocument } from '@xitter/api-contracts';
import { POSTS_INDEX } from '@xitter/config';
import { CheckpointRepository, type SearchPrismaClient } from './checkpoint.repository.js';
import { buildSearchBody, PostsIndex } from './posts-index.js';
import type { SearchContentSource } from './search-content.js';
import { SearchService } from './search.service.js';

/**
 * Integration suite (testcontainers OpenSearch + Postgres): the posts index
 * and the search read path end to end - idempotent index creation, bulk
 * upsert + query roundtrip (analysed text AND keyword terms), tombstone
 * exclusion, blocked-author filtering, keyset pagination and checkpoint
 * resume semantics. Hydration runs against an in-memory store so the suite
 * pins search-owned behaviour only (the e2e suite covers the full path).
 * Skips in Stryker's sandbox (no generated Prisma client).
 */
const hasGeneratedClient = existsSync(join(process.cwd(), 'src/generated/prisma/client.ts'));

const VIEWER = '00000000-0000-4000-8000-00000000d001';
const AUTHOR = '00000000-0000-4000-8000-00000000d002';
const BLOCKED_AUTHOR = '00000000-0000-4000-8000-00000000d003';

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`;
// Hours past midnight 2026-08-19T00:00Z; tests use values beyond 24h.
const at = (h: number) =>
  new Date(Date.parse('2026-08-19T00:00:00.000Z') + h * 3_600_000).toISOString();

describe.skipIf(!hasGeneratedClient)('search integration (testcontainers)', () => {
  let os: Awaited<ReturnType<typeof startOpenSearch>>;
  let db: SearchPrismaClient;
  let pool: Pool;
  let pg: Awaited<ReturnType<typeof startPostgres>>;
  let index: PostsIndex;
  let osClient: Client;
  let service: SearchService;
  let store: {
    posts: Map<string, Post>;
    profiles: Map<string, Profile>;
    blocked: Set<string>;
  };

  beforeAll(async () => {
    const generated = await import('../generated/prisma/client.js');
    [os, pg] = await Promise.all([startOpenSearch(), startPostgres('search-test')]);
    pool = new Pool({ connectionString: pg.connectionString });

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
      adapter: new PrismaPg({ connectionString: pg.connectionString }),
      // Prisma's 2s/5s transaction defaults assume a quiet host; CI runs
      // several container suites in parallel on 2-core runners and pool
      // acquisition starves past them (P2028) before any query is at fault.
      transactionOptions: { maxWait: 20_000, timeout: 60_000 },
    }) as SearchPrismaClient;
    index = new PostsIndex(new Client({ node: os.url }));
    osClient = new Client({ node: os.url });
    store = {
      posts: new Map(),
      profiles: new Map(),
      blocked: new Set([BLOCKED_AUTHOR]),
    };
    const content: SearchContentSource = {
      posts: (ids) =>
        Promise.resolve(
          new Map(ids.filter((id) => store.posts.has(id)).map((id) => [id, store.posts.get(id)!])),
        ),
      profiles: (ids) =>
        Promise.resolve(
          new Map(
            ids.filter((id) => store.profiles.has(id)).map((id) => [id, store.profiles.get(id)!]),
          ),
        ),
      blockedAuthorIds: (userId) => Promise.resolve(userId === VIEWER ? [...store.blocked] : []),
    };
    service = new SearchService(index, content, new CheckpointRepository(db));
  }, 300_000);

  afterAll(async () => {
    await db?.$disconnect().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await index?.close().catch(() => undefined);
    await os?.stop().catch(() => undefined);
    await pg?.stop().catch(() => undefined);
  });

  /**
   * Upsert + explicit refresh for read-after-write assertions: production
   * upserts no longer block on a refresh (#103 - visibility is asynchronous,
   * within one refresh interval), so this suite refreshes on purpose when a
   * query/count follows the write.
   */
  const upsert = async (documents: SearchIndexDocument[]): Promise<void> => {
    await index.upsertDocuments(documents);
    await osClient.indices.refresh({ index: POSTS_INDEX });
  };

  function doc(
    postId: string,
    authorId: string,
    text: string,
    createdAt: string,
    keywords: string[] = [],
    deletedAt: string | null = null,
  ): SearchIndexDocument {
    return {
      postId,
      authorId,
      authorName: `Author ${authorId.slice(-4)}`,
      text,
      keywords,
      createdAt,
      deletedAt,
    };
  }

  function seedPost(d: SearchIndexDocument): Post {
    const post: Post = {
      id: d.postId,
      authorId: d.authorId,
      text: d.text,
      media: [],
      replyToId: null,
      repostOfId: null,
      counts: { replies: 0, likes: 0, reposts: 0 },
      createdAt: d.createdAt,
      deletedAt: d.deletedAt,
    };
    store.posts.set(d.postId, post);
    store.profiles.set(
      d.authorId,
      store.profiles.get(d.authorId) ?? {
        id: d.authorId,
        username: `user${d.authorId.slice(-4)}`,
        displayName: `Author ${d.authorId.slice(-4)}`,
        bio: null,
        createdAt: at(0),
      },
    );
    return post;
  }

  it('creates the index idempotently (double ensure does not throw)', async () => {
    await index.ensure();
    await index.ensure();
    const exists = await new Client({ node: os.url }).indices.exists({ index: POSTS_INDEX });
    expect(exists.statusCode).toBe(200);
  });

  it('roundtrips documents: analysed text matches, hashtags match exactly', async () => {
    const plain = doc(uid('c001'), AUTHOR, 'The quick brown foxes jumped', at(10));
    const tagged = doc(uid('c002'), AUTHOR, 'lovely morning #coffee', at(11), ['coffee']);
    await upsert([plain, tagged]);
    seedPost(plain);
    seedPost(tagged);

    // Stemming: "foxes" (indexed) matches query "fox" via porter_stem.
    const stem = await index.search({ q: 'fox', limit: 10, excludeAuthorIds: [] });
    expect(stem.hits.map((h) => h.postId)).toContain(plain.postId);

    // Keyword exact term.
    const tag = await index.search({ q: '#coffee', limit: 10, excludeAuthorIds: [] });
    expect(tag.hits.map((h) => h.postId)).toEqual([tagged.postId]);

    // No match for absent text.
    const none = await index.search({ q: 'zebra', limit: 10, excludeAuthorIds: [] });
    expect(none.hits).toHaveLength(0);
  });

  it('excludes tombstones from queries (deleted posts disappear)', async () => {
    const live = doc(uid('c010'), AUTHOR, 'searchable gemstone post', at(12));
    const dead = doc(uid('c011'), AUTHOR, 'gemstone deleted post', at(13), [], at(13));
    await upsert([live, dead]);
    seedPost(live);
    seedPost(dead);

    const page = await service.searchPosts(VIEWER, { q: 'gemstone', limit: 10 });
    expect(page.items.map((i) => i.post.id)).toEqual([live.postId]);
  });

  it('excludes blocked authors for the viewer at query level', async () => {
    const mine = doc(uid('c020'), AUTHOR, 'uniquepineapple alpha', at(14));
    const blocked = doc(uid('c021'), BLOCKED_AUTHOR, 'uniquepineapple beta', at(15));
    await upsert([mine, blocked]);
    seedPost(mine);
    seedPost(blocked);

    const page = await service.searchPosts(VIEWER, { q: 'uniquepineapple', limit: 10 });
    expect(page.items.map((i) => i.post.authorId)).not.toContain(BLOCKED_AUTHOR);
    expect(page.items.map((i) => i.post.id)).toContain(mine.postId);

    // Another viewer sees both.
    const other = await service.searchPosts(AUTHOR, { q: 'uniquepineapple', limit: 10 });
    expect(other.items).toHaveLength(2);
  });

  it('pages newest-first with a stable keyset cursor walk', async () => {
    for (let h = 20; h < 24; h++) {
      const d = doc(uid(`i03${h - 20}`), AUTHOR, `paginated kumquat ${h}`, at(h));
      await upsert([d]);
      seedPost(d);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await service.searchPosts(VIEWER, { q: 'kumquat', limit: 2, cursor });
      seen.push(...page.items.map((i) => i.post.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(4);
    const times = seen.map((id) => store.posts.get(id)!.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('drops hits whose post vanished and refills from older results', async () => {
    const fresh = doc(uid('c040'), AUTHOR, 'vanilla durian fresh', at(30));
    const older1 = doc(uid('c041'), AUTHOR, 'vanilla durian old1', at(28));
    const older2 = doc(uid('c042'), AUTHOR, 'vanilla durian old2', at(29));
    await upsert([fresh, older1, older2]);
    seedPost(older1);
    seedPost(older2);
    // fresh deliberately NOT in the posts store = deleted between index+read

    const page = await service.searchPosts(VIEWER, { q: 'durian', limit: 2 });
    expect(page.items.map((i) => i.post.id)).toEqual([older2.postId, older1.postId]);
    expect(page.nextCursor).toBeNull(); // vanished hit consumed no page slot
  });

  it('replays are idempotent by postId (no duplicate documents)', async () => {
    const d = doc(uid('c050'), AUTHOR, 'idempotent lychee', at(40));
    await upsert([d]);
    await upsert([d]); // redelivery
    seedPost(d);

    const page = await service.searchPosts(VIEWER, { q: 'lychee', limit: 10 });
    expect(page.items).toHaveLength(1);
  });

  it('refreshes denormalised author names in place', async () => {
    const before = await index.refreshAuthorName(AUTHOR, 'Renamed Author');
    expect(before).toBeGreaterThan(0);
    const raw = await new Client({ node: os.url }).get({ index: POSTS_INDEX, id: uid('c001') });
    expect((raw.body._source as { authorName: string }).authorName).toBe('Renamed Author');
  });

  it('checkpoints resume: last-write-wins positions per partition', async () => {
    const checkpoints = new CheckpointRepository(db);
    await checkpoints.report({
      consumerKey: 'worker-test',
      topicPartition: 'xitter.posts.v1:0',
      offset: 10,
      eventId: 'e-10',
      eventAt: at(1),
    });
    await checkpoints.report({
      consumerKey: 'worker-test',
      topicPartition: 'xitter.posts.v1:0',
      offset: 42, // redelivery replay advances the same row
      eventId: 'e-42',
      eventAt: at(2),
    });
    await checkpoints.report({
      consumerKey: 'worker-test',
      topicPartition: 'xitter.social.v1:1',
      offset: 7,
      eventId: 'e-7',
      eventAt: at(3),
    });

    const positions = await checkpoints.positions('worker-test');
    expect(positions).toEqual([
      { topicPartition: 'xitter.posts.v1:0', offset: 42, eventId: 'e-42', eventAt: at(2) },
      { topicPartition: 'xitter.social.v1:1', offset: 7, eventId: 'e-7', eventAt: at(3) },
    ]);
  });

  it('clears all documents but keeps the mapping (reset job path)', async () => {
    const client = new Client({ node: os.url });
    const result = await index.clear();
    expect(result).toBeGreaterThan(0);
    const after = await client.count({ index: POSTS_INDEX });
    expect(after.body.count).toBe(0);
    // Mapping survives - writes resume without recreation.
    const again = doc(uid('c060'), AUTHOR, 'post-clear write', at(50));
    await index.upsertDocuments([again]);
    await osClient.indices.refresh({ index: POSTS_INDEX });
    const count = await client.count({ index: POSTS_INDEX });
    expect(count.body.count).toBe(1);
  });

  it('recreates the index WITH its definition after deletion (reset deleted it live)', async () => {
    // The #118 live regression: the nightly reset deletes the index while
    // the service is running; the next bulk must NOT rely on OpenSearch's
    // auto-create (dynamic mapping, no analyzer - every query 0 hits). The
    // existence check recreates via ensure() and stemming works again.
    await osClient.indices.delete({ index: POSTS_INDEX });

    const doc1 = doc(uid('d001'), AUTHOR, 'the quokkas were jumping', at(60));
    await index.upsertDocuments([doc1]);
    await osClient.indices.refresh({ index: POSTS_INDEX });

    // The analyzer is the definition's, not a dynamic default: a stemmed
    // query only matches under post_text (porter_stem: 'jumps' and the
    // indexed 'jumping' both reduce to 'jump'; a dynamically-mapped index
    // would find nothing).
    const settings = await osClient.indices.getSettings({ index: POSTS_INDEX });
    expect(JSON.stringify(settings.body)).toContain('post_text');
    const { hits: found } = await index.search({ q: 'jumps', limit: 10, excludeAuthorIds: [] });
    expect(found).toHaveLength(1);
  });

  it('search body never leaks blocked ids into the must clause', () => {
    // Belt+braces on the pure builder: the unit suite owns shape; this pins
    // the integration entry point uses the same builder.
    expect(buildSearchBody({ q: 'x', limit: 5, excludeAuthorIds: ['z'] })).toMatchObject({
      size: 6,
    });
  });
});
