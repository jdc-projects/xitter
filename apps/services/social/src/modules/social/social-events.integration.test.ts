import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kafka, type Consumer } from 'kafkajs';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { startKafka, startPostgres } from '@xitter/testing';
import { createEventProducer } from '@xitter/events';
import { KafkaSocialEvents } from './social-events.js';
import { SocialService } from './social.service.js';
import { SocialRepository, type SocialPrismaClient } from './social.repository.js';

/**
 * Event emission contract: relationship changes + profile edits produce
 * spec-04 events on xitter.social.v1 with the shared envelope. Runs against
 * throwaway Kafka + Postgres containers. Skips in Stryker's sandbox (no
 * generated Prisma client there).
 */
const hasGeneratedClient = existsSync(join(process.cwd(), 'src/generated/prisma/client.ts'));

describe.skipIf(!hasGeneratedClient)('social events (testcontainers kafka)', () => {
  let db: SocialPrismaClient;
  let pool: Pool;
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let kafka: Awaited<ReturnType<typeof startKafka>>;
  let emitter: KafkaSocialEvents;
  let service: SocialService;
  let consumer: Consumer;
  const received: { eventType: string; payload: Record<string, unknown> }[] = [];

  const A = '00000000-0000-4000-8000-00000000a001';
  const B = '00000000-0000-4000-8000-00000000b002';

  beforeAll(async () => {
    const generated = await import('../../generated/prisma/client.js');
    [postgres, kafka] = await Promise.all([startPostgres('social-events-test'), startKafka()]);

    const migration = readFileSync(
      join(process.cwd(), 'prisma/migrations/20260816000000_init/migration.sql'),
      'utf8',
    );
    pool = new Pool({ connectionString: postgres.connectionString });
    for (const statement of migration.split(/;\s*\n/).filter((s) => s.trim().length > 0)) {
      await pool.query(statement);
    }

    db = new generated.PrismaClient({
      adapter: new PrismaPg({ connectionString: postgres.connectionString }),
    }) as SocialPrismaClient;

    const brokers = kafka.bootstrapServers.split(',');
    emitter = new KafkaSocialEvents(
      createEventProducer({ clientId: 'social-test', brokers }),
      'social',
    );
    service = new SocialService(new SocialRepository(db), emitter);

    consumer = new Kafka({ clientId: 'social-events-test', brokers }).consumer({
      groupId: `social-events-test-${crypto.randomUUID()}`,
    });
    await consumer.connect();
    // Auto-create only fires on produce (the broker refuses it on metadata
    // requests) - create the topic up front so subscribe has something to find.
    const admin = new Kafka({ clientId: 'social-events-test', brokers }).admin();
    await admin.connect();
    await admin.createTopics({ topics: [{ topic: 'xitter.social.v1' }] });
    await admin.disconnect();
    await consumer.subscribe({ topic: 'xitter.social.v1', fromBeginning: true });
    await consumer.run({
      eachMessage: async ({ message }) => {
        const envelope = JSON.parse(message.value?.toString('utf8') ?? '{}') as {
          eventType: string;
          payload: Record<string, unknown>;
        };
        received.push({ eventType: envelope.eventType, payload: envelope.payload });
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

  it('emits the full relationship event sequence with envelopes', async () => {
    await service.ensureProfile({ id: A, username: 'eventa' }, { displayName: 'Event A' });
    await service.ensureProfile({ id: B, username: 'eventb' }, { displayName: 'Event B' });

    await service.follow(A, B);
    await waitFor(() => received.some((e) => e.eventType === 'social.follow.created'));
    let event = received.find((e) => e.eventType === 'social.follow.created')!;
    expect(event.payload).toMatchObject({ followerId: A, followeeId: B });

    await service.updateProfile(A, A, { bio: 'events test' });
    await waitFor(() =>
      received.some(
        (e) =>
          e.eventType === 'social.profile.updated' &&
          e.payload.profileId === A &&
          e.payload.bio === 'events test',
      ),
    );
    event = received.find(
      (e) =>
        e.eventType === 'social.profile.updated' &&
        e.payload.profileId === A &&
        e.payload.bio === 'events test',
    )!;
    expect(event.payload).toMatchObject({
      profileId: A,
      username: 'eventa',
      bio: 'events test',
    });

    await service.block(A, B);
    await waitFor(() => received.some((e) => e.eventType === 'social.block.created'));
    // Blocking killed the follow: its deletion event is on the topic too.
    expect(received.some((e) => e.eventType === 'social.follow.deleted')).toBe(true);

    await service.unblock(A, B);
    await waitFor(() => received.some((e) => e.eventType === 'social.block.deleted'));

    await service.unfollow(A, B); // no-op: the block already removed the follow
    await new Promise((r) => setTimeout(r, 1_000));
    expect(
      received.filter((e) => e.eventType === 'social.follow.deleted' && e.payload.followerId === A),
    ).toHaveLength(1);
  }, 240_000);
});
