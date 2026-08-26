import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@opensearch-project/opensearch';
import { Kafka } from 'kafkajs';
import { startKafka, startOpenSearch } from '@xitter/testing';
import { POSTS_INDEX, postsIndexDefinition } from '@xitter/config';
import { CONSUMER_GROUPS, createEventConsumer, createEventProducer } from '@xitter/events';
import type { Profile } from '@xitter/api-contracts';
import { handleBatch, type SearchApi, type SocialApi } from './handlers.js';

/**
 * Search-index consumption contract against throwaway Kafka + OpenSearch
 * (testcontainers): the real consumer wiring from main.ts (group, topics,
 * fromBeginning, BATCHED eachBatch mode) driving the real handleBatch, fed
 * by a real producer - the search internal API is faked with a direct
 * OpenSearch writer using the shared index definition, so the suite proves
 * the full worker -> index -> query roundtrip, the batch -> flush ->
 * checkpoint ordering, and checkpoint resume after group loss.
 */
const AUTHOR = '00000000-0000-4000-8000-00000000a001';
const NOW = '2026-08-19T09:00:00.000Z';

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`;

/** Ordered side-effect journal: proves flush-before-checkpoint ordering. */
type JournalEntry =
  | { kind: 'bulk-ok'; at: number; docs: string[] }
  | { kind: 'bulk-failed'; at: number; docs: string[] }
  | { kind: 'checkpoint'; at: number; topicPartition: string; offset: number };

describe('search-index consumption (testcontainers kafka + opensearch)', () => {
  let kafka: Awaited<ReturnType<typeof startKafka>>;
  let os: Awaited<ReturnType<typeof startOpenSearch>>;
  let producer: Awaited<ReturnType<typeof createEventProducer>>;
  let consumer: Awaited<ReturnType<typeof createEventConsumer>>;
  let client: Client;
  const checkpoints = new Map<string, number>();
  const eventsSeen: string[] = [];
  const journal: JournalEntry[] = [];
  let journalClock = 0;
  /** One-shot bulk failure injector (mid-batch redelivery test). */
  let failNextBulk = false;

  // The search internal API seam, backed by the real OpenSearch via the
  // shared index definition (what the service's PostsIndex does) - including
  // the async-refresh write semantics (#103).
  const search: SearchApi = {
    internalUpsertDocuments: (documents) => {
      const docs = documents.map((doc) => doc.postId);
      if (failNextBulk) {
        failNextBulk = false;
        journal.push({ kind: 'bulk-failed', at: journalClock++, docs });
        return Promise.reject(new Error('injected mid-batch failure'));
      }
      const body = documents.flatMap((doc) => [
        { index: { _index: POSTS_INDEX, _id: doc.postId } },
        doc,
      ]);
      return client.bulk({ body, refresh: false }).then((res) => {
        if (res.body.errors) {
          journal.push({ kind: 'bulk-failed', at: journalClock++, docs });
          throw new Error(`bulk failed: ${JSON.stringify(res.body.items?.[0])}`);
        }
        journal.push({ kind: 'bulk-ok', at: journalClock++, docs });
        return { indexed: documents.length };
      });
    },
    internalRefreshAuthors: (authors) => {
      // Mirrors PostsIndex.refreshAuthorName (#103): update_by_query is
      // search-based with conflicts: 'proceed', so a rename following an
      // unrefreshed upsert 409s and silently skips the new doc - the
      // pre-refresh makes the rename deterministic.
      const body = {
        query: { terms: { authorId: authors.map((a) => a.authorId) } },
        script: {
          source: 'ctx._source.authorName = params.names[ctx._source.authorId]',
          params: { names: Object.fromEntries(authors.map((a) => [a.authorId, a.authorName])) },
        },
      };
      return client.indices
        .refresh({ index: POSTS_INDEX })
        .catch(() => undefined)
        .then(() =>
          client.updateByQuery({ index: POSTS_INDEX, body, conflicts: 'proceed', refresh: true }),
        )
        .then(() => ({ updated: 0 }));
    },
    internalPutCheckpoint: (input) => {
      checkpoints.set(input.topicPartition, input.offset);
      journal.push({
        kind: 'checkpoint',
        at: journalClock++,
        topicPartition: input.topicPartition,
        offset: input.offset,
      });
      return Promise.resolve();
    },
  };
  const social: SocialApi = {
    internalProfiles: (userIds) => {
      const items: Profile[] = userIds.map((id) => ({
        id,
        username: `user${id.slice(-4)}`,
        displayName: 'Demo Author',
        bio: null,
        createdAt: NOW,
      }));
      return Promise.resolve({ items });
    },
  };

  beforeAll(async () => {
    [kafka, os] = await Promise.all([startKafka(), startOpenSearch()]);
    client = new Client({ node: os.url });
    await client.indices.create({ index: POSTS_INDEX, body: postsIndexDefinition() });

    const brokers = kafka.bootstrapServers.split(',');
    const admin = new Kafka({ clientId: 'search-index-test-admin', brokers }).admin();
    await admin.connect();
    await admin.createTopics({
      topics: [{ topic: 'xitter.posts.v1' }, { topic: 'xitter.social.v1' }],
    });
    await admin.disconnect();

    producer = createEventProducer({ clientId: 'search-index-test-producer', brokers });
    consumer = createEventConsumer({
      clientId: 'search-index-test-consumer',
      brokers,
      groupId: `${CONSUMER_GROUPS.searchIndexWorker}-test-${crypto.randomUUID()}`,
      topics: ['posts', 'social'],
      fromBeginning: true,
    });
    await consumer.runBatch((events, context) => {
      for (const { envelope } of events) eventsSeen.push((envelope as { eventType: string }).eventType);
      return handleBatch(events, context, {
        search,
        social,
        consumerKey: CONSUMER_GROUPS.searchIndexWorker,
      });
    });
  }, 300_000);

  afterAll(async () => {
    await consumer?.disconnect().catch(() => undefined);
    await producer?.disconnect().catch(() => undefined);
    await client?.close().catch(() => undefined);
    await os?.stop().catch(() => undefined);
    await kafka?.stop().catch(() => undefined);
  });

  async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('timed out waiting for search-index consumption');
  }

  /**
   * Fresh groups join at the log end; re-emit until consumed (idempotent).
   * The producer's eager connect can still be mid-flight on the first emit
   * (kafkajs throws 'producer is disconnected' from send() before its own
   * retry kicks in), so the transient case is retried once after a beat.
   */
  async function emitUntil(
    emit: () => Promise<void>,
    predicate: () => Promise<boolean>,
  ): Promise<void> {
    const deadline = Date.now() + 45_000;
    for (;;) {
      try {
        await emit();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const transient = message.includes('disconnected') || message.includes('Connection');
        if (!transient || Date.now() > deadline) throw err;
        await new Promise((r) => setTimeout(r, 1_000));
        continue;
      }
      if (Date.now() > deadline) break;
      await waitFor(() => false, 3_000).catch(() => undefined); // settle window
      if (await predicate()) return;
    }
    throw new Error('timed out waiting for search-index consumption');
  }

  async function indexedText(postId: string): Promise<string | null> {
    const res = await client.get({ index: POSTS_INDEX, id: postId }).catch(() => null);
    if (!res || !res.body.found) return null;
    return (res.body._source as { text: string }).text;
  }

  const emitPost = (postId: string, text: string, key = postId) =>
    producer.emit('posts', {
      eventType: 'posts.post.created',
      producer: 'posts',
      occurredAt: NOW,
      key,
      payload: {
        postId,
        authorId: AUTHOR,
        text,
        mediaIds: [],
        replyToId: null,
        repostOfId: null,
        createdAt: NOW,
      },
    });

  it('roundtrips: created -> indexed, deleted -> tombstoned, profile -> renamed', async () => {
    const postId = uid('f001');
    const emit = () => emitPost(postId, 'roundtrip mango #tropical');

    await emitUntil(emit, () => indexedText(postId).then((text) => text !== null));
    expect(await indexedText(postId)).toBe('roundtrip mango #tropical');
    expect(eventsSeen).toContain('posts.post.created');
    // Checkpoint advanced for the consumed message.
    expect([...checkpoints.values()].some((offset) => offset >= 0)).toBe(true);

    // Delete: the doc stays as a tombstone with deletedAt set.
    await emitUntil(
      () =>
        producer.emit('posts', {
          eventType: 'posts.post.deleted',
          producer: 'posts',
          occurredAt: NOW,
          key: postId,
          payload: { postId, authorId: AUTHOR, deletedAt: NOW },
        }),
      async () => {
        const res = await client.get({ index: POSTS_INDEX, id: postId }).catch(() => null);
        return Boolean(res && (res.body._source as { deletedAt: string | null }).deletedAt);
      },
    );

    // Tombstones never match queries (async-refresh writes: refresh on
    // purpose before the query, #103).
    await client.indices.refresh({ index: POSTS_INDEX });
    const query = await client.search({
      index: POSTS_INDEX,
      body: {
        query: {
          bool: {
            must: { match: { text: 'mango' } },
            filter: [{ bool: { must_not: { exists: { field: 'deletedAt' } } } }],
          },
        },
      },
    });
    const total = query.body.hits.total;
    expect(typeof total === 'number' ? total : (total?.value ?? 0)).toBe(0);

    // Profile update refreshes the denormalised name.
    const second = uid('f002');
    await emitUntil(
      () =>
        emitPost(second, 'second papaya post').then(() =>
          producer.emit('social', {
            eventType: 'social.profile.updated',
            producer: 'social',
            occurredAt: NOW,
            key: AUTHOR,
            payload: {
              profileId: AUTHOR,
              username: 'demo1',
              displayName: 'Fresh Name',
              bio: null,
              updatedAt: NOW,
            },
          }),
        ),
      async () => {
        const res = await client.get({ index: POSTS_INDEX, id: second }).catch(() => null);
        return Boolean(
          res && (res.body._source as { authorName: string }).authorName === 'Fresh Name',
        );
      },
    );
  }, 120_000);

  it('batches: a burst lands in fewer bulks than documents, checkpointed only after the flush', async () => {
    const burst = Array.from({ length: 12 }, (_, i) => uid(`f10${String(i).padStart(2, '0')}`));

    await emitUntil(
      async () => {
        for (const postId of burst) await emitPost(postId, `burst lychee ${postId.slice(-4)}`);
      },
      async () => {
        for (const postId of burst) if ((await indexedText(postId)) === null) return false;
        return true;
      },
    );

    const burstBulks = journal.filter(
      (entry): entry is { kind: 'bulk-ok'; at: number; docs: string[] } =>
        entry.kind === 'bulk-ok' && entry.docs.some((doc) => burst.includes(doc)),
    );
    // The mechanism: kafkajs handed us multiple messages per fetch batch and
    // the worker flushed them together - strictly fewer bulk calls than
    // documents, with at least one multi-doc bulk.
    const docsBulkked = burstBulks.reduce((sum, entry) => sum + entry.docs.length, 0);
    expect(docsBulkked).toBeGreaterThanOrEqual(burst.length); // replays allowed
    expect(burstBulks.length).toBeLessThan(burst.length);
    expect(Math.max(...burstBulks.map((entry) => entry.docs.length))).toBeGreaterThanOrEqual(2);

    // Ordering: the checkpoint that covers the burst follows the bulk that
    // landed its last documents - the checkpoint never precedes a flush.
    const lastBulkAt = Math.max(...burstBulks.map((entry) => entry.at));
    const coveringCheckpoint = journal
      .filter(
        (entry): entry is { kind: 'checkpoint'; at: number; offset: number } =>
          entry.kind === 'checkpoint' && entry.topicPartition.startsWith('xitter.posts.v1'),
      )
      .some((entry) => entry.at > lastBulkAt);
    expect(coveringCheckpoint).toBe(true);
  }, 120_000);

  it('redelivery: a mid-batch bulk failure checkpoints nothing until the whole batch re-flushes', async () => {
    const probe = Array.from({ length: 4 }, (_, i) => uid(`f11${String(i).padStart(2, '0')}`));

    failNextBulk = true;
    await emitUntil(
      async () => {
        for (const postId of probe) await emitPost(postId, `redelivery durian ${postId.slice(-4)}`);
      },
      async () => {
        for (const postId of probe) if ((await indexedText(postId)) === null) return false;
        return true;
      },
    );

    // Exactly one injected failure, and its whole doc set re-landed in a
    // later successful bulk (whole-batch redelivery, nothing dropped).
    const failed = journal.filter((entry) => entry.kind === 'bulk-failed');
    expect(failed).toHaveLength(1);
    const [failure] = failed as Array<{ kind: 'bulk-failed'; at: number; docs: string[] }>;
    const recovered = journal.some(
      (entry) =>
        entry.kind === 'bulk-ok' &&
        entry.at > failure.at &&
        failure.docs.every((doc) => entry.docs.includes(doc)),
    );
    expect(recovered).toBe(true);

    // No checkpoint landed between the failed flush and its recovery - the
    // resume cursor never pointed past unprocessed work.
    const between = journal.filter(
      (entry) => entry.kind === 'checkpoint' && entry.at > failure.at,
    ) as Array<{ kind: 'checkpoint'; at: number; offset: number }>;
    const recoveryAt = (
      journal.find(
        (entry) =>
          entry.kind === 'bulk-ok' &&
          failure.docs.every((doc) => entry.docs.includes(doc)),
      ) as { at: number }
    ).at;
    expect(between.some((entry) => entry.at < recoveryAt)).toBe(false);
    // ...and once the batch did land, its checkpoint followed.
    expect(between.some((entry) => entry.at > recoveryAt)).toBe(true);
  }, 120_000);

  it('resumes from checkpoints after consumer-group loss (no data skipped)', async () => {
    // Two posts on one partition (same key -> ordered).
    const first = uid('f010');
    const second = uid('f011');
    await emitUntil(
      async () => {
        await emitPost(first, 'resume checkpoint guava one', 'resume-probe');
        await emitPost(second, 'resume checkpoint guava two', 'resume-probe');
      },
      async () => (await indexedText(second)) !== null,
    );

    // Simulate group loss: a NEW consumer group with the checkpoint resume
    // map. The checkpoints record the offset of the last processed message
    // per partition; the new group resumes at offset + 1, so replays are
    // skipped without losing anything emitted after the checkpoint.
    const seenAfterResume: string[] = [];
    const positions = new Map<string, number>();
    for (const [topicPartition, offset] of checkpoints) {
      positions.set(topicPartition, offset + 1);
    }
    const resumed = createEventConsumer({
      clientId: 'search-index-test-resume',
      brokers: kafka.bootstrapServers.split(','),
      groupId: `${CONSUMER_GROUPS.searchIndexWorker}-resume-${crypto.randomUUID()}`,
      topics: ['posts', 'social'],
      fromBeginning: true,
    });
    await resumed.run(
      async (envelope) => {
        seenAfterResume.push((envelope as { payload: { text?: string } }).payload?.text ?? '');
      },
      { resumeFrom: positions },
    );

    // Emit one NEW event after the wipe: it must arrive; the pre-checkpoint
    // backlog must NOT be reprocessed.
    const after = uid('f012');
    await emitUntil(
      () => emitPost(after, 'resume checkpoint guava three', 'resume-probe'),
      async () => seenAfterResume.includes('resume checkpoint guava three'),
    );

    expect(seenAfterResume).not.toContain('resume checkpoint guava one');
    expect(seenAfterResume).not.toContain('resume checkpoint guava two');
    await resumed.disconnect();
  }, 120_000);
});
