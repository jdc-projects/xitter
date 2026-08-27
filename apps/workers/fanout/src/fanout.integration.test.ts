import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Kafka } from 'kafkajs';
import { startKafka } from '@xitter/testing';
import { CONSUMER_GROUPS, createEventConsumer, createEventProducer } from '@xitter/events';
import type { Post } from '@xitter/api-contracts';
import { handleConsumedEvent, type FeedApi, type PostsApi, type SocialApi } from './handlers.js';

/**
 * Fanout consumption contract against a throwaway Kafka (testcontainers):
 * the real consumer wiring from main.ts (group, topics) driving the real
 * handleConsumedEvent, fed by a real producer - entry correctness, backfill window
 * and removals asserted through the recorded internal-API calls (the feed
 * service's DB-side behaviour is covered by its own integration suite; the
 * e2e suite covers the full path).
 */
const AUTHOR = '00000000-0000-4000-8000-00000000a001';
const FOLLOWER_1 = '00000000-0000-4000-8000-00000000b001';
const FOLLOWER_2 = '00000000-0000-4000-8000-00000000b002';
const NOW = '2026-08-18T09:00:00.000Z';

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`;

describe('fanout consumption (testcontainers kafka)', () => {
  let kafka: Awaited<ReturnType<typeof startKafka>>;
  let producer: Awaited<ReturnType<typeof createEventProducer>>;
  let consumer: Awaited<ReturnType<typeof createEventConsumer>>;

  const followerIds = vi.fn((_userId: string) => Promise.resolve([FOLLOWER_1, FOLLOWER_2]));
  const userPosts = vi.fn((_userId: string, _cursor?: string, _limit?: number) =>
    Promise.resolve({ items: [] as Post[], nextCursor: null as string | null }),
  );
  const upsertEntries = vi.fn((_entries: unknown[]) => Promise.resolve({ inserted: 0 }));
  const deletePostEntries = vi.fn((_postId: string) => Promise.resolve({ deleted: 1 }));
  const deleteAuthorEntries = vi.fn((_userId: string, _authorId: string) =>
    Promise.resolve({ deleted: 1 }),
  );
  const deleteRepostEntries = vi.fn((_postId: string, _repostedById: string) =>
    Promise.resolve({ deleted: 1 }),
  );
  // The suite consumer checkpoints like the real worker (the resume test
  // asserts this wiring end to end with its own dedicated recorders).
  const putCheckpoint = vi.fn(() => Promise.resolve());

  beforeAll(async () => {
    kafka = await startKafka();
    const brokers = kafka.bootstrapServers.split(',');

    const admin = new Kafka({ clientId: 'fanout-test-admin', brokers }).admin();
    await admin.connect();
    await admin.createTopics({
      topics: [{ topic: 'xitter.posts.v1' }, { topic: 'xitter.social.v1' }],
    });
    await admin.disconnect();

    producer = createEventProducer({ clientId: 'fanout-test-producer', brokers });
    consumer = createEventConsumer({
      clientId: 'fanout-test-consumer',
      brokers,
      groupId: `${CONSUMER_GROUPS.fanoutWorker}-test-${crypto.randomUUID()}`,
      topics: ['posts', 'social'],
    });

    const deps = {
      social: { internalFollowerIds: followerIds } as unknown as SocialApi,
      posts: { internalGetAuthorPosts: userPosts } as unknown as PostsApi,
      feed: {
        internalUpsertEntries: upsertEntries,
        internalDeletePostEntries: deletePostEntries,
        internalDeleteAuthorEntries: deleteAuthorEntries,
        internalDeleteRepostEntries: deleteRepostEntries,
        internalPutCheckpoint: putCheckpoint,
      } as unknown as FeedApi,
      consumerKey: CONSUMER_GROUPS.fanoutWorker,
    };
    await consumer.run((envelope, raw) => handleConsumedEvent(envelope, raw, deps));
  }, 240_000);

  afterAll(async () => {
    await consumer?.disconnect().catch(() => undefined);
    await producer?.disconnect().catch(() => undefined);
    await kafka?.stop();
  });

  async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('timed out waiting for fanout consumption');
  }

  /**
   * A fresh consumer group starts at the log end at assignment time, so an
   * event emitted before the join completes is missed (createEventConsumer
   * subscribes fromBeginning: false). Re-emit until the handler records it -
   * handlers are idempotent doubles, so replays are harmless.
   */
  async function emitUntil(emit: () => Promise<void>, predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      await emit();
      await waitFor(predicate, 3_000).catch(() => undefined);
      if (predicate()) return;
    }
    throw new Error('timed out waiting for fanout consumption');
  }

  it('fans a post out to author + followers on the consumed event', async () => {
    const postId = uid('e001');
    const emit = () =>
      producer.emit('posts', {
        eventType: 'posts.post.created',
        producer: 'posts',
        occurredAt: NOW,
        key: postId,
        payload: {
          postId,
          authorId: AUTHOR,
          text: 'hello feed',
          mediaIds: [],
          replyToId: null,
          repostOfId: null,
          createdAt: NOW,
        },
      });

    await emitUntil(emit, () => upsertEntries.mock.calls.length > 0);
    const entries = upsertEntries.mock.calls[0]![0] as { userId: string }[];
    expect(entries.map((e) => e.userId).sort()).toEqual([AUTHOR, FOLLOWER_1, FOLLOWER_2].sort());
    expect(followerIds).toHaveBeenCalledWith(AUTHOR);
    // Every consumed event is checkpointed after its side effects (#149).
    expect(putCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ consumerKey: CONSUMER_GROUPS.fanoutWorker }),
    );
  }, 90_000);

  it('backfills the followee recent posts into the follower feed', async () => {
    const followeePosts = [1, 2, 3].map((n) => ({
      id: uid(`f00${n}`),
      authorId: AUTHOR,
      text: `old post ${n}`,
      media: [],
      replyToId: null,
      repostOfId: null,
      counts: { replies: 0, likes: 0, reposts: 0 },
      createdAt: NOW,
      deletedAt: null,
    }));
    userPosts.mockResolvedValue({ items: followeePosts, nextCursor: null });

    const before = upsertEntries.mock.calls.length;
    const emit = () =>
      producer.emit('social', {
        eventType: 'social.follow.created',
        producer: 'social',
        occurredAt: NOW,
        key: FOLLOWER_1,
        payload: { followerId: FOLLOWER_1, followeeId: AUTHOR, createdAt: NOW },
      });

    await emitUntil(emit, () => upsertEntries.mock.calls.length > before);
    expect(userPosts).toHaveBeenCalledWith(AUTHOR, undefined, 20);
    const entries = upsertEntries.mock.calls.at(-1)![0] as {
      userId: string;
      postId: string;
    }[];
    expect(entries).toHaveLength(3);
    expect(new Set(entries.map((e) => e.userId))).toEqual(new Set([FOLLOWER_1]));
    expect(entries.map((e) => e.postId)).toEqual(followeePosts.map((p) => p.id));
  }, 60_000);

  it('removes entries on post.deleted and follow.deleted', async () => {
    const postId = uid('e00d');
    const done = () =>
      deletePostEntries.mock.calls.some(([id]) => id === postId) &&
      deleteAuthorEntries.mock.calls.some(
        ([follower, followee]) => follower === FOLLOWER_2 && followee === AUTHOR,
      );
    const emit = () =>
      producer
        .emit('posts', {
          eventType: 'posts.post.deleted',
          producer: 'posts',
          occurredAt: NOW,
          key: postId,
          payload: { postId, authorId: AUTHOR, deletedAt: NOW },
        })
        .then(() =>
          producer.emit('social', {
            eventType: 'social.follow.deleted',
            producer: 'social',
            occurredAt: NOW,
            key: FOLLOWER_2,
            payload: { followerId: FOLLOWER_2, followeeId: AUTHOR, deletedAt: NOW },
          }),
        );

    await emitUntil(emit, done);
  }, 90_000);

  it('fans repost interactions out and undoes them (#8)', async () => {
    const postId = uid('e00e');
    const before = upsertEntries.mock.calls.length;
    const emitted = () => upsertEntries.mock.calls.length > before;
    const emitRepost = () =>
      producer.emit('posts', {
        eventType: 'posts.interaction.created',
        producer: 'posts',
        occurredAt: NOW,
        key: postId,
        payload: {
          interactionId: uid('e00f'),
          kind: 'repost',
          postId,
          userId: AUTHOR,
          createdAt: NOW,
        },
      });

    await emitUntil(emitRepost, emitted);
    expect(followerIds).toHaveBeenCalledWith(AUTHOR); // reposter's followers
    const entries = upsertEntries.mock.calls.at(-1)![0] as {
      userId: string;
      reason: string;
      repostedById: string;
    }[];
    expect(entries.every((e) => e.reason === 'repost' && e.repostedById === AUTHOR)).toBe(true);

    const undone = () =>
      deleteRepostEntries.mock.calls.some(([id, by]) => id === postId && by === AUTHOR);
    const emitUndo = () =>
      producer.emit('posts', {
        eventType: 'posts.interaction.deleted',
        producer: 'posts',
        occurredAt: NOW,
        key: postId,
        payload: { kind: 'repost', postId, userId: AUTHOR, deletedAt: NOW },
      });

    await emitUntil(emitUndo, undone);
  }, 120_000);

  it('keys same-aggregate events to one partition (ordered consumption)', async () => {
    // One shared key emitted repeatedly: every event with that key must
    // arrive on the same partition - that is the per-aggregate ordering
    // guarantee spec 04 documents (a post's lifecycle stays ordered).
    const seen: { key: string; partition: number }[] = [];
    const probe = createEventConsumer({
      clientId: 'fanout-test-probe',
      brokers: kafka.bootstrapServers.split(','),
      groupId: `fanout-probe-${crypto.randomUUID()}`,
      topics: ['posts'],
    });
    await probe.run(async (_envelope, raw) => {
      const key = raw.message.key?.toString('utf8');
      if (key === 'probe-shared') seen.push({ key, partition: raw.partition });
    });

    let n = 0;
    const emit = () =>
      producer.emit('posts', {
        eventType: 'posts.post.created',
        producer: 'posts',
        occurredAt: NOW,
        key: 'probe-shared',
        payload: {
          postId: uid(`e1${String(++n).padStart(3, '0')}`),
          authorId: AUTHOR,
          text: 'probe',
          mediaIds: [],
          replyToId: null,
          repostOfId: null,
          createdAt: NOW,
        },
      });

    await emitUntil(emit, () => seen.length >= 3);

    expect(new Set(seen.map((s) => s.partition)).size).toBe(1); // one partition

    await probe.disconnect();
  }, 90_000);

  it('resumes from the durable checkpoint after downtime - events produced while down are consumed (#149)', async () => {
    // Same key throughout: one partition, so the checkpoint cursor and the
    // downtime events share an ordered log.
    const KEY = 'fanout-resume-probe';
    const postA = uid('e2a1');
    const postB = uid('e2b1');
    const postC = uid('e2c1');
    const emitPost = (postId: string) =>
      producer.emit('posts', {
        eventType: 'posts.post.created',
        producer: 'posts',
        occurredAt: NOW,
        key: KEY,
        payload: {
          postId,
          authorId: AUTHOR,
          text: 'resume probe',
          mediaIds: [],
          replyToId: null,
          repostOfId: null,
          createdAt: NOW,
        },
      });

    // Dedicated side-effect recorders for the resume scenario: the suite's
    // long-lived consumer keeps consuming everything in its own group, so
    // shared mocks could not attribute B/C to the resumed worker.
    const resumeUpserts = vi.fn((_entries: unknown[]) => Promise.resolve({ inserted: 0 }));
    const resumeCheckpoints: { topicPartition: string; offset: number }[] = [];
    const resumeDeps = {
      social: { internalFollowerIds: followerIds } as unknown as SocialApi,
      posts: { internalGetAuthorPosts: userPosts } as unknown as PostsApi,
      feed: {
        internalUpsertEntries: resumeUpserts,
        internalDeletePostEntries: deletePostEntries,
        internalDeleteAuthorEntries: deleteAuthorEntries,
        internalDeleteRepostEntries: deleteRepostEntries,
        internalPutCheckpoint: vi.fn((input: { topicPartition: string; offset: number }) => {
          resumeCheckpoints.push({ topicPartition: input.topicPartition, offset: input.offset });
          return Promise.resolve();
        }),
      } as unknown as FeedApi,
      consumerKey: CONSUMER_GROUPS.fanoutWorker,
    };
    /** How many fan-out upsert batches carried this post's entries. */
    const upsertsOf = (postId: string) =>
      resumeUpserts.mock.calls.filter((entries) =>
        (entries[0] as { postId: string }[]).some((entry) => entry.postId === postId),
      ).length;

    // The worker under test: its own consumer group (fromBeginning so the
    // emit cannot race the group's first join). Group loss is the harshest
    // resume scenario - only the durable checkpoint survives it.
    const worker1 = createEventConsumer({
      clientId: 'fanout-test-resume-1',
      brokers: kafka.bootstrapServers.split(','),
      groupId: `${CONSUMER_GROUPS.fanoutWorker}-resume1-${crypto.randomUUID()}`,
      topics: ['posts', 'social'],
      fromBeginning: true,
    });
    await worker1.run((envelope, raw) => handleConsumedEvent(envelope, raw, resumeDeps));

    await emitPost(postA);
    await waitFor(() => upsertsOf(postA) > 0);
    // The checkpoint write follows the upsert inside the same handler
    // invocation; let it land before snapshotting the resume positions.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const resumeFrom = new Map<string, number>();
    for (const { topicPartition, offset } of resumeCheckpoints) {
      resumeFrom.set(topicPartition, Math.max(resumeFrom.get(topicPartition) ?? -1, offset) + 1);
    }
    expect(resumeFrom.size).toBeGreaterThan(0); // the worker checkpointed its positions
    const handledBefore = upsertsOf(postA);

    // Downtime: the worker is down while two posts are produced.
    await worker1.disconnect();
    await emitPost(postB);
    await emitPost(postC);

    // Boot: a fresh group carrying the durable positions (what main.ts
    // fetches from the feed checkpoint store) must consume the gap rather
    // than seek past it.
    const worker2 = createEventConsumer({
      clientId: 'fanout-test-resume-2',
      brokers: kafka.bootstrapServers.split(','),
      groupId: `${CONSUMER_GROUPS.fanoutWorker}-resume2-${crypto.randomUUID()}`,
      topics: ['posts', 'social'],
      fromBeginning: true,
    });
    await worker2.run((envelope, raw) => handleConsumedEvent(envelope, raw, resumeDeps), {
      resumeFrom,
    });

    await waitFor(() => upsertsOf(postB) > 0 && upsertsOf(postC) > 0, 60_000);

    expect(upsertsOf(postB)).toBeGreaterThan(0); // downtime event consumed
    expect(upsertsOf(postC)).toBeGreaterThan(0); // downtime event consumed
    expect(upsertsOf(postA)).toBe(handledBefore); // pre-checkpoint backlog not replayed

    await worker2.disconnect();
  }, 240_000);
});
