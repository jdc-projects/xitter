import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@opensearch-project/opensearch';
import { Kafka } from 'kafkajs';
import { startKafka, startOpenSearch } from '@xitter/testing';
import { POSTS_INDEX, postsIndexDefinition } from '@xitter/config';
import { CONSUMER_GROUPS, createEventConsumer, createEventProducer } from '@xitter/events';
import type { Profile } from '@xitter/api-contracts';
import { handleEvent, type SearchApi, type SocialApi } from './handlers.js';

/**
 * Search-index consumption contract against throwaway Kafka + OpenSearch
 * (testcontainers): the real consumer wiring from main.ts (group, topics,
 * fromBeginning) driving the real handleEvent, fed by a real producer - the
 * search internal API is faked with a direct OpenSearch writer using the
 * shared index definition, so the suite proves the full worker -> index
 * -> query roundtrip plus checkpoint resume after group loss.
 */
const AUTHOR = '00000000-0000-4000-8000-00000000a001';
const NOW = '2026-08-19T09:00:00.000Z';

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`;

describe('search-index consumption (testcontainers kafka + opensearch)', () => {
  let kafka: Awaited<ReturnType<typeof startKafka>>;
  let os: Awaited<ReturnType<typeof startOpenSearch>>;
  let producer: Awaited<ReturnType<typeof createEventProducer>>;
  let consumer: Awaited<ReturnType<typeof createEventConsumer>>;
  let client: Client;
  const checkpoints = new Map<string, number>();
  const eventsSeen: string[] = [];

  // The search internal API seam, backed by the real OpenSearch via the
  // shared index definition (what the service's PostsIndex does) - including
  // the async-refresh write semantics (#103).
  const search: SearchApi = {
    internalUpsertDocuments: (documents) => {
      const body = documents.flatMap((doc) => [
        { index: { _index: POSTS_INDEX, _id: doc.postId } },
        doc,
      ]);
      return client.bulk({ body, refresh: false }).then((res) => {
        if (res.body.errors) {
          throw new Error(`bulk failed: ${JSON.stringify(res.body.items?.[0])}`);
        }
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
    await consumer.run((envelope, raw) => {
      eventsSeen.push((envelope as { eventType: string }).eventType);
      return handleEvent(envelope, raw, {
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

  it('roundtrips: created -> indexed, deleted -> tombstoned, profile -> renamed', async () => {
    const postId = uid('f001');
    const emit = () =>
      producer.emit('posts', {
        eventType: 'posts.post.created',
        producer: 'posts',
        occurredAt: NOW,
        key: postId,
        payload: {
          postId,
          authorId: AUTHOR,
          text: 'roundtrip mango #tropical',
          mediaIds: [],
          replyToId: null,
          repostOfId: null,
          createdAt: NOW,
        },
      });

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
        producer
          .emit('posts', {
            eventType: 'posts.post.created',
            producer: 'posts',
            occurredAt: NOW,
            key: second,
            payload: {
              postId: second,
              authorId: AUTHOR,
              text: 'second papaya post',
              mediaIds: [],
              replyToId: null,
              repostOfId: null,
              createdAt: NOW,
            },
          })
          .then(() =>
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

  it('resumes from checkpoints after consumer-group loss (no data skipped)', async () => {
    // Two posts on one partition (same key -> ordered).
    const first = uid('f010');
    const second = uid('f011');
    await emitUntil(
      () =>
        producer
          .emit('posts', {
            eventType: 'posts.post.created',
            producer: 'posts',
            occurredAt: NOW,
            key: 'resume-probe',
            payload: {
              postId: first,
              authorId: AUTHOR,
              text: 'resume checkpoint guava one',
              mediaIds: [],
              replyToId: null,
              repostOfId: null,
              createdAt: NOW,
            },
          })
          .then(() =>
            producer.emit('posts', {
              eventType: 'posts.post.created',
              producer: 'posts',
              occurredAt: NOW,
              key: 'resume-probe',
              payload: {
                postId: second,
                authorId: AUTHOR,
                text: 'resume checkpoint guava two',
                mediaIds: [],
                replyToId: null,
                repostOfId: null,
                createdAt: NOW,
              },
            }),
          ),
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
      () =>
        producer.emit('posts', {
          eventType: 'posts.post.created',
          producer: 'posts',
          occurredAt: NOW,
          key: 'resume-probe',
          payload: {
            postId: after,
            authorId: AUTHOR,
            text: 'resume checkpoint guava three',
            mediaIds: [],
            replyToId: null,
            repostOfId: null,
            createdAt: NOW,
          },
        }),
      async () => seenAfterResume.includes('resume checkpoint guava three'),
    );

    expect(seenAfterResume).not.toContain('resume checkpoint guava one');
    expect(seenAfterResume).not.toContain('resume checkpoint guava two');
    await resumed.disconnect();
  }, 120_000);
});
