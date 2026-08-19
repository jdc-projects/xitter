import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kafka, type Consumer } from 'kafkajs';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { startKafka, startPostgres } from '@xitter/testing';
import { eventSchemas, createEventProducer, type EventEnvelope } from '@xitter/events';
import { KafkaPostsEvents } from './posts-events.js';
import { PostsService } from './posts.service.js';
import { PostsRepository, type PostsPrismaClient } from './posts.repository.js';
import { NullRelationshipChecker } from './relationship-checker.js';
import { NullMediaChecker } from './media-checker.js';
import { NullInteractionRealtime } from './interaction-realtime.js';

/**
 * Event emission contract: post create/delete produce spec-04 events on
 * xitter.posts.v1 with the shared envelope, and payloads validate against
 * @xitter/events schemas. Runs against throwaway Kafka + Postgres
 * containers. Skips in Stryker's sandbox (no generated Prisma client there).
 */
const hasGeneratedClient = existsSync(join(process.cwd(), 'src/generated/prisma/client.ts'));

describe.skipIf(!hasGeneratedClient)('posts events (testcontainers kafka)', () => {
  let db: PostsPrismaClient;
  let pool: Pool;
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let kafka: Awaited<ReturnType<typeof startKafka>>;
  let emitter: KafkaPostsEvents;
  let service: PostsService;
  let consumer: Consumer;
  const received: EventEnvelope[] = [];

  const AUTHOR = '00000000-0000-4000-8000-00000000e001';

  beforeAll(async () => {
    const generated = await import('../generated/prisma/client.js');
    [postgres, kafka] = await Promise.all([startPostgres('posts-events-test'), startKafka()]);

    const migration = readFileSync(
      join(process.cwd(), 'prisma/migrations/20260817000000_init/migration.sql'),
      'utf8',
    );
    pool = new Pool({ connectionString: postgres.connectionString });
    for (const statement of migration.split(/;\s*\n/).filter((s) => s.trim().length > 0)) {
      await pool.query(statement);
    }
    // Follow-up migrations (media snapshot column) apply in order like deploys.
    const followUp = readFileSync(
      join(process.cwd(), 'prisma/migrations/20260818120000_media_snapshot/migration.sql'),
      'utf8',
    );
    for (const statement of followUp.split(/;\s*\n/).filter((s) => s.trim().length > 0)) {
      await pool.query(statement);
    }

    db = new generated.PrismaClient({
      adapter: new PrismaPg({ connectionString: postgres.connectionString }),
    }) as PostsPrismaClient;

    const brokers = kafka.bootstrapServers.split(',');
    emitter = new KafkaPostsEvents(
      createEventProducer({ clientId: 'posts-test', brokers }),
      'posts',
    );
    service = new PostsService(
      new PostsRepository(db),
      emitter,
      new NullRelationshipChecker(),
      new NullMediaChecker(), new NullInteractionRealtime());

    consumer = new Kafka({ clientId: 'posts-events-test', brokers }).consumer({
      groupId: `posts-events-test-${crypto.randomUUID()}`,
    });
    await consumer.connect();
    // Auto-create only fires on produce (the broker refuses it on metadata
    // requests) - create the topic up front so subscribe has something to find.
    const admin = new Kafka({ clientId: 'posts-events-test', brokers }).admin();
    await admin.connect();
    await admin.createTopics({ topics: [{ topic: 'xitter.posts.v1' }] });
    await admin.disconnect();
    await consumer.subscribe({ topic: 'xitter.posts.v1', fromBeginning: true });
    await consumer.run({
      eachMessage: async ({ message }) => {
        received.push(JSON.parse(message.value?.toString('utf8') ?? '{}') as EventEnvelope);
      },
    });
  }, 180_000);

  afterAll(async () => {
    await consumer?.disconnect().catch(() => undefined);
    await emitter?.shutdown().catch(() => undefined);
    await db?.$disconnect().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await postgres?.stop();
    await kafka?.stop();
  });

  async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('timed out waiting for events');
  }

  it('emits post.created and post.deleted with valid envelopes', async () => {
    const mediaId = '00000000-0000-4000-8000-0000000003d1';
    const post = await service.create(AUTHOR, {
      text: 'hello events',
      mediaIds: [mediaId],
      replyToId: null,
    });
    await waitFor(() => received.some((e) => e.eventType === 'posts.post.created'));

    const created = received.find((e) => e.eventType === 'posts.post.created')!;
    expect(created.producer).toBe('posts');
    expect(created.eventVersion).toBe(1);
    expect(created.payload).toMatchObject({
      postId: post.id,
      authorId: AUTHOR,
      text: 'hello events',
      mediaIds: [mediaId],
      replyToId: null,
      repostOfId: null,
    });
    // Payload validates against the shared discriminated-union schema.
    expect(() =>
      eventSchemas.parse({
        eventType: created.eventType,
        ...(created.payload as Record<string, unknown>),
      }),
    ).not.toThrow();

    const reply = await service.create(AUTHOR, {
      text: 'threaded',
      mediaIds: [],
      replyToId: post.id,
    });
    await waitFor(() =>
      received.some(
        (e) =>
          e.eventType === 'posts.post.created' &&
          (e.payload as { replyToId?: string }).replyToId === post.id,
      ),
    );
    expect(() =>
      eventSchemas.parse({
        eventType: 'posts.post.created',
        postId: reply.id,
        authorId: AUTHOR,
        text: 'threaded',
        mediaIds: [],
        replyToId: post.id,
        repostOfId: null,
        createdAt: reply.createdAt,
      }),
    ).not.toThrow();

    await service.remove(AUTHOR, reply.id);
    await waitFor(() => received.some((e) => e.eventType === 'posts.post.deleted'));
    const deleted = received.find((e) => e.eventType === 'posts.post.deleted')!;
    expect(deleted.payload).toMatchObject({ postId: reply.id, authorId: AUTHOR });
  }, 240_000);
});
