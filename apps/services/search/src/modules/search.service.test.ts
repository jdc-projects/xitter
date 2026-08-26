import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { Post, Profile, SearchIndexDocument } from '@xitter/api-contracts';
import { decodeCursor } from '@xitter/service-kit';
import { CheckpointRepository, type CheckpointInput, type SearchDb } from './checkpoint.repository.js';
import type { PostHit, PostsIndex, SearchOptions, SearchOutcome } from './posts-index.js';
import type { SearchContentSource } from './search-content.js';
import { SearchService } from './search.service.js';

/**
 * Unit suite for the search read path between the controller and PostsIndex:
 * page assembly, the bounded refill walk when hydration drops hits, cursor
 * translation, and the internal worker/reset surface. PostsIndex and the
 * content clients are fakes with the same contracts as the real ones, so the
 * assertions pin outcomes (page contents, drop accounting, cursor positions)
 * without OpenSearch or cross-service HTTP.
 */

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`;
const at = (h: number) =>
  new Date(Date.parse('2026-08-25T00:00:00.000Z') + h * 3_600_000).toISOString();

const VIEWER = uid('3001');
const OTHER_VIEWER = uid('3002');

interface SeedDoc {
  postId: string;
  authorId: string;
  createdAt: string;
  text: string;
  /** false = post deleted between index and read: the hit drops at hydration. */
  live: boolean;
  /** false = author profile vanished: a placeholder author renders. */
  profileKnown: boolean;
}

const seed = (post: string, author: string, hours: number, overrides: Partial<SeedDoc> = {}): SeedDoc => ({
  postId: uid(post),
  authorId: uid(author),
  createdAt: at(hours),
  text: `post ${post} needle`,
  live: true,
  profileKnown: true,
  ...overrides,
});

const postFrom = (doc: SeedDoc): Post => ({
  id: doc.postId,
  authorId: doc.authorId,
  text: doc.text,
  media: [],
  replyToId: null,
  repostOfId: null,
  counts: { replies: 0, likes: 0, reposts: 0 },
  createdAt: doc.createdAt,
  deletedAt: null,
});

const profileFor = (id: string): Profile => ({
  id,
  username: `user${id.slice(-4)}`,
  displayName: `Author ${id.slice(-4)}`,
  bio: null,
  createdAt: at(0),
});

const hitFrom = (doc: SeedDoc): PostHit => ({
  postId: doc.postId,
  authorId: doc.authorId,
  createdAt: doc.createdAt,
});

/**
 * In-memory PostsIndex. Corpus mode mirrors the real query contract closely
 * enough to pin the service's control flow: (createdAt, postId) keyset walk
 * newest first, viewer exclusions, text matching, and nextAfter only when
 * another page exists. script() hands back exact outcomes for drop and
 * walk-boundary cases a corpus cannot express.
 */
class FakeIndex {
  readonly calls: SearchOptions[] = [];
  readonly upserts: SearchIndexDocument[][] = [];
  readonly renames: Array<{ authorId: string; authorName: string }> = [];
  upsertCount = 0;
  clearCount = 0;
  clearResult = 0;
  readonly renameCounts = new Map<string, number>();
  private readonly scripted: SearchOutcome[] = [];

  constructor(private readonly corpus: SeedDoc[]) {}

  script(...outcomes: SearchOutcome[]): void {
    this.scripted.push(...outcomes);
  }

  async search(options: SearchOptions): Promise<SearchOutcome> {
    this.calls.push(options);
    const outcome = this.scripted.shift();
    if (outcome) return outcome;

    const after = options.after;
    const matching = this.corpus
      .filter((doc) => !options.excludeAuthorIds.includes(doc.authorId))
      .filter((doc) => doc.text.toLowerCase().includes(options.q.toLowerCase()))
      .filter(
        (doc) =>
          !after ||
          doc.createdAt < after.createdAt ||
          (doc.createdAt === after.createdAt && doc.postId < after.postId),
      )
      .sort((a, b) =>
        a.createdAt === b.createdAt ? (a.postId < b.postId ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
      );
    const hits = matching.slice(0, options.limit).map(hitFrom);
    const last = hits.at(-1);
    const hasMore = matching.length > options.limit;
    return { hits, nextAfter: hasMore && last ? { createdAt: last.createdAt, postId: last.postId } : null };
  }

  async upsertDocuments(documents: SearchIndexDocument[]): Promise<number> {
    this.upserts.push(documents);
    if (documents.length === 0) return 0;
    return this.upsertCount;
  }

  async refreshAuthorName(authorId: string, authorName: string): Promise<number> {
    this.renames.push({ authorId, authorName });
    return this.renameCounts.get(authorId) ?? 0;
  }

  async clear(): Promise<number> {
    this.clearCount += 1;
    return this.clearResult;
  }
}

/** In-memory content source recording every bulk lookup it serves. */
class FakeContent implements SearchContentSource {
  readonly postsCalls: string[][] = [];
  readonly profilesCalls: string[][] = [];
  readonly blockedCalls: string[] = [];
  readonly postStore = new Map<string, Post>();
  readonly profileStore = new Map<string, Profile>();
  readonly blocks = new Map<string, string[]>();

  async posts(postIds: string[]): Promise<Map<string, Post>> {
    this.postsCalls.push([...postIds]);
    return new Map(postIds.filter((id) => this.postStore.has(id)).map((id) => [id, this.postStore.get(id)!]));
  }

  async profiles(userIds: string[]): Promise<Map<string, Profile>> {
    this.profilesCalls.push([...userIds]);
    return new Map(
      userIds.filter((id) => this.profileStore.has(id)).map((id) => [id, this.profileStore.get(id)!]),
    );
  }

  async blockedAuthorIds(userId: string): Promise<string[]> {
    this.blockedCalls.push(userId);
    return this.blocks.get(userId) ?? [];
  }
}

interface CheckpointRow {
  consumerKey: string;
  topicPartition: string;
  lastOffset: bigint;
  lastEventId: string;
  lastEventAt: Date;
}

/**
 * In-memory Prisma stand-in for the SearchCheckpoint delegate (upsert/
 * findMany/deleteMany - exactly the surface CheckpointRepository touches).
 * The real repository runs against it, so the service's pass-throughs are
 * exercised down to persisted rows.
 */
function fakeCheckpointDb(): SearchDb {
  const rows = new Map<string, CheckpointRow>();
  const db = {
    searchCheckpoint: {
      upsert: async (args: {
        where: { consumerKey_topicPartition: { consumerKey: string; topicPartition: string } };
        create: CheckpointRow;
      }) => {
        const { consumerKey, topicPartition } = args.where.consumerKey_topicPartition;
        rows.set(`${consumerKey}/${topicPartition}`, { ...args.create });
        return {};
      },
      findMany: async (args: { where: { consumerKey: string } }) =>
        [...rows.values()].filter((row) => row.consumerKey === args.where.consumerKey),
      deleteMany: async () => {
        const count = rows.size;
        rows.clear();
        return { count };
      },
    },
  };
  return db as unknown as SearchDb;
}

function harness(corpus: SeedDoc[]) {
  const index = new FakeIndex(corpus);
  const content = new FakeContent();
  for (const doc of corpus) {
    if (doc.live) content.postStore.set(doc.postId, postFrom(doc));
    if (doc.profileKnown) content.profileStore.set(doc.authorId, profileFor(doc.authorId));
  }
  const service = new SearchService(
    index as unknown as PostsIndex,
    content,
    new CheckpointRepository(fakeCheckpointDb()),
  );
  return { index, content, service };
}

describe('SearchService.searchPosts page assembly', () => {
  it('returns a full page of hydrated items, newest first, with no cursor at the end', async () => {
    const docs = [seed('1001', '2001', 1), seed('1002', '2002', 2), seed('1003', '2003', 3)];
    const { index, content, service } = harness(docs);

    const page = await service.searchPosts(VIEWER, { q: 'needle', limit: 3 });

    expect(page.items.map((item) => item.post.id)).toEqual([
      docs[2].postId,
      docs[1].postId,
      docs[0].postId,
    ]);
    expect(page.nextCursor).toBeNull();
    expect(page.items[0]).toEqual({
      post: content.postStore.get(docs[2].postId)!,
      author: content.profileStore.get(docs[2].authorId)!,
      reason: 'post', // search results are plain posts, never repost entries
      repostedBy: null,
    });
    expect(index.calls).toEqual([{ q: 'needle', limit: 3, after: null, excludeAuthorIds: [] }]);
  });

  it('matches the requested query text (non-matching posts never render)', async () => {
    const matching = seed('1001', '2001', 2);
    const other = seed('1002', '2002', 1, { text: 'nothing relevant here' });
    const { service } = harness([matching, other]);

    const page = await service.searchPosts(VIEWER, { q: 'needle', limit: 10 });

    expect(page.items.map((item) => item.post.id)).toEqual([matching.postId]);
  });

  it('caps the page at the contract ceiling of 50 regardless of the requested limit', async () => {
    const docs = Array.from({ length: 80 }, (_, i) => seed(`1${String(i).padStart(3, '0')}`, '2001', i));
    const { index, service } = harness(docs);

    const page = await service.searchPosts(VIEWER, { q: 'needle', limit: 500 });

    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).not.toBeNull();
    expect(index.calls).toHaveLength(1); // a full page needs no refill walk
    expect(index.calls[0]?.limit).toBe(50);

    const small = await service.searchPosts(VIEWER, { q: 'needle', limit: 10 });
    expect(small.items).toHaveLength(10);
  });

  it('returns an empty page with no cursor and no upstream lookups when nothing matches', async () => {
    const { index, content, service } = harness([seed('1001', '2001', 1)]);

    const page = await service.searchPosts(VIEWER, { q: 'ghost', limit: 10 });

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(index.calls).toHaveLength(1);
    expect(content.postsCalls).toEqual([]); // empty hits never hit the bulk lookup
  });

  it('rejects a forged cursor with a 400 before any search runs', async () => {
    const { index, service } = harness([seed('1001', '2001', 1)]);

    const rejection = service.searchPosts(VIEWER, {
      q: 'needle',
      limit: 5,
      cursor: '%00zz-not-base64',
    });
    await expect(rejection).rejects.toBeInstanceOf(BadRequestException);
    await expect(rejection).rejects.toMatchObject({
      response: { error: { code: 'VALIDATION_ERROR', message: 'Invalid pagination cursor' } },
    });
    expect(index.calls).toEqual([]);
  });

  it('walks the keyset cursor: every post served exactly once, cursor pinned to the last item served', async () => {
    const docs = [1, 2, 3, 4, 5].map((h) => seed(`10${String(h).padStart(2, '0')}`, '2001', h));
    const { service } = harness(docs);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await service.searchPosts(VIEWER, { q: 'needle', limit: 2, cursor });
      seen.push(...page.items.map((item) => item.post.id));
      if (!page.nextCursor) break;
      const last = page.items.at(-1)!;
      expect(decodeCursor(page.nextCursor)).toEqual({ createdAt: last.post.createdAt, id: last.post.id });
      cursor = page.nextCursor;
    }

    expect(seen).toEqual([
      docs[4].postId,
      docs[3].postId,
      docs[2].postId,
      docs[1].postId,
      docs[0].postId,
    ]);
  });

  it('excludes the viewer’s blocked authors; other viewers still see them', async () => {
    const mine = seed('1001', '2001', 1);
    const blocked = seed('1002', '2002', 2);
    const { index, content, service } = harness([mine, blocked]);
    content.blocks.set(VIEWER, [blocked.authorId]);

    const page = await service.searchPosts(VIEWER, { q: 'needle', limit: 10 });
    expect(page.items.map((item) => item.post.id)).toEqual([mine.postId]);
    expect(index.calls[0]?.excludeAuthorIds).toEqual([blocked.authorId]);

    const other = await service.searchPosts(OTHER_VIEWER, { q: 'needle', limit: 10 });
    expect(other.items.map((item) => item.post.id)).toEqual([blocked.postId, mine.postId]);
    expect(content.blockedCalls).toEqual([VIEWER, OTHER_VIEWER]);
  });
});

describe('SearchService.searchPosts refill walks (hydration drops)', () => {
  it('drops hits whose post vanished and refills the page from older results', async () => {
    const vanished = seed('1001', '2001', 3, { live: false });
    const older1 = seed('1002', '2002', 2);
    const older2 = seed('1003', '2003', 1);
    const { index, content, service } = harness([vanished, older1, older2]);

    const page = await service.searchPosts(VIEWER, { q: 'needle', limit: 2 });

    expect(page.items.map((item) => item.post.id)).toEqual([older1.postId, older2.postId]);
    expect(page.nextCursor).toBeNull(); // the vanished hit consumed no page slot
    expect(index.calls).toHaveLength(2);
    expect(index.calls[1]).toEqual({
      q: 'needle',
      limit: 1, // refill asks for the remaining space only
      after: { createdAt: older1.createdAt, postId: older1.postId }, // keyset advanced
      excludeAuthorIds: [],
    });
    expect(content.postsCalls).toEqual([
      [vanished.postId, older1.postId], // looked up once, absent - dropped
      [older2.postId],
    ]);
  });

  it('bounds refill walks at four: an undersized page still carries a continuation cursor', async () => {
    const good = seed('1090', '2090', 9);
    const neverReached = seed('1091', '2091', 8);
    const { index, content, service } = harness([good, neverReached]);
    const dropped = (post: string, hours: number): PostHit => ({
      postId: uid(post),
      authorId: uid('2001'),
      createdAt: at(hours),
    });
    const d1 = dropped('1081', 4);
    const d2 = dropped('1082', 3);
    const d3 = dropped('1083', 2);
    const goodHit = hitFrom(good);
    const position = (hit: PostHit) => ({ createdAt: hit.createdAt, postId: hit.postId });
    index.script(
      { hits: [d1], nextAfter: position(d1) },
      { hits: [d2], nextAfter: position(d2) },
      { hits: [d3], nextAfter: position(d3) },
      { hits: [goodHit], nextAfter: position(goodHit) },
      // A fifth walk would serve this live hit; the walk budget must stop it.
      { hits: [hitFrom(neverReached)], nextAfter: position(hitFrom(neverReached)) },
    );

    const page = await service.searchPosts(VIEWER, { q: 'needle', limit: 2 });

    expect(page.items.map((item) => item.post.id)).toEqual([good.postId]);
    expect(index.calls).toHaveLength(4);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor!)).toEqual({ createdAt: good.createdAt, id: good.postId });
    expect(content.postsCalls).toEqual([[d1.postId], [d2.postId], [d3.postId], [good.postId]]);
  });

  it('stops as soon as the index reports the end of results (no restart from the top)', async () => {
    const vanished = seed('1001', '2001', 2, { live: false });
    const live = seed('1002', '2002', 1);
    const { index, service } = harness([vanished, live]);

    const page = await service.searchPosts(VIEWER, { q: 'needle', limit: 2 });

    expect(page.items.map((item) => item.post.id)).toEqual([live.postId]);
    expect(page.nextCursor).toBeNull();
    expect(index.calls).toHaveLength(1);
  });

  it('never exceeds the requested limit even when a walk returns more than asked', async () => {
    // The real index never over-serves; this pins the service's own ceiling.
    const docs = [seed('1001', '2001', 3), seed('1002', '2002', 2), seed('1003', '2003', 1)];
    const { index, service } = harness(docs);
    const hits = docs.map(hitFrom);
    index.script({ hits, nextAfter: { createdAt: hits[0]!.createdAt, postId: hits[0]!.postId } });

    const page = await service.searchPosts(VIEWER, { q: 'needle', limit: 2 });

    expect(page.items.map((item) => item.post.id)).toEqual([docs[0].postId, docs[1].postId]);
    expect(page.nextCursor).not.toBeNull();
  });
});

describe('SearchService.searchPosts hydration shape', () => {
  it('renders a placeholder author when the profile vanished; known profiles render as-is', async () => {
    const known = seed('1001', '2001', 2);
    const unknown = seed('1002', '2002', 1, { profileKnown: false });
    const { content, service } = harness([known, unknown]);

    const page = await service.searchPosts(VIEWER, { q: 'needle', limit: 10 });

    expect(page.items[0]?.author).toEqual(content.profileStore.get(known.authorId)!);
    expect(page.items[1]?.author).toEqual({
      id: unknown.authorId,
      username: 'unknown',
      displayName: 'Unknown',
      bio: null,
      createdAt: new Date(0).toISOString(),
    });
  });

  it('dedupes post and profile ids before the bulk lookups', async () => {
    const a = seed('1001', '2001', 2);
    const b = seed('1002', '2001', 1); // same author as a
    const { index, content, service } = harness([a, b]);
    const hitA = hitFrom(a);
    index.script({
      hits: [hitA, { ...hitA }, hitFrom(b)], // a replayed hit in one page
      nextAfter: null,
    });

    const page = await service.searchPosts(VIEWER, { q: 'needle', limit: 5 });

    expect(content.postsCalls).toEqual([[a.postId, b.postId]]);
    expect(content.profilesCalls).toEqual([[a.authorId]]);
    expect(page.items.map((item) => item.post.id)).toEqual([a.postId, a.postId, b.postId]);
  });
});

describe('SearchService internal surface (search-index worker + reset job)', () => {
  it('reports the number of documents handed to the index (0 for an empty batch)', async () => {
    const { index, service } = harness([]);
    index.upsertCount = 7;
    const documents: SearchIndexDocument[] = [
      {
        postId: uid('1001'),
        authorId: uid('2001'),
        authorName: 'Author One',
        text: 'needle',
        keywords: [],
        createdAt: at(1),
        deletedAt: null,
      },
      {
        postId: uid('1002'),
        authorId: uid('2001'),
        authorName: 'Author One',
        text: 'needle again',
        keywords: [],
        createdAt: at(2),
        deletedAt: null,
      },
    ];

    await expect(service.upsertDocuments(documents)).resolves.toEqual({ indexed: 7 });
    await expect(service.upsertDocuments([])).resolves.toEqual({ indexed: 0 });
    expect(index.upserts).toEqual([documents, []]);
  });

  it('sums author renames across the batch and forwards each pair', async () => {
    const { index, service } = harness([]);
    const one = uid('2001');
    const two = uid('2002');
    index.renameCounts.set(one, 2);
    index.renameCounts.set(two, 3);
    const authors = [
      { authorId: one, authorName: 'Renamed One' },
      { authorId: two, authorName: 'Renamed Two' },
    ];

    await expect(service.refreshAuthors(authors)).resolves.toEqual({ updated: 5 });
    await expect(service.refreshAuthors([])).resolves.toEqual({ updated: 0 });
    expect(index.renames).toEqual(authors);
  });

  it('persists worker checkpoints and reads the resume positions back', async () => {
    const { service } = harness([]);
    const input = (offset: number): CheckpointInput => ({
      consumerKey: 'worker-search',
      topicPartition: 'xitter.posts.v1:0',
      offset,
      eventId: `e-${offset}`,
      eventAt: at(2),
    });

    await service.reportCheckpoint(input(10));
    await service.reportCheckpoint(input(42)); // redelivery advances the same row
    await service.reportCheckpoint({ ...input(7), topicPartition: 'xitter.social.v1:1' });

    await expect(service.checkpointPositions('worker-search')).resolves.toEqual([
      { topicPartition: 'xitter.posts.v1:0', offset: 42, eventId: 'e-42', eventAt: at(2) },
      { topicPartition: 'xitter.social.v1:1', offset: 7, eventId: 'e-7', eventAt: at(2) },
    ]);
  });

  it('clears indexed documents for the reset job and truncates checkpoints separately', async () => {
    const { index, service } = harness([]);
    index.clearResult = 9;
    const checkpoint = (partition: string, offset: number): CheckpointInput => ({
      consumerKey: 'worker-search',
      topicPartition: partition,
      offset,
      eventId: `e-${offset}`,
      eventAt: at(1),
    });
    await service.reportCheckpoint(checkpoint('xitter.posts.v1:0', 1));
    await service.reportCheckpoint(checkpoint('xitter.social.v1:1', 2));

    await expect(service.clearIndex()).resolves.toEqual({ deleted: 9 });
    await expect(service.reseed()).resolves.toEqual({ deleted: 2 }); // both checkpoint rows
    expect(index.clearCount).toBe(1);
  });
});
