import { Inject, Injectable } from '@nestjs/common';
import type { FeedCheckpointPosition } from '@xitter/api-contracts';
import type { PrismaClient } from '../generated/prisma/client.js';
import { FEED_PRISMA } from './feed.repository.js';

export type FeedCheckpointDb = Pick<PrismaClient, 'feedCheckpoint'>;

export type CheckpointInput = {
  consumerKey: string;
  topicPartition: string;
  offset: number;
  eventId: string;
  eventAt: string;
};

/**
 * Prisma data access for the fanout worker's resume positions
 * (FeedCheckpoint, #149) - the feed-owned twin of search's
 * CheckpointRepository. One row per (consumer, topic-partition), upserted
 * after every processed event: a worker restart outside a reset resumes
 * here instead of at the log end (which would permanently skip the
 * downtime gap). Feed owns the store because fanout materialises feed's
 * data (storage ownership: no cross-service DB access).
 */
@Injectable()
export class CheckpointRepository {
  constructor(@Inject(FEED_PRISMA) private readonly db: FeedCheckpointDb) {}

  /** Idempotent position upsert (last-write-wins by processed offset). */
  async report(input: CheckpointInput): Promise<void> {
    await this.db.feedCheckpoint.upsert({
      where: {
        consumerKey_topicPartition: {
          consumerKey: input.consumerKey,
          topicPartition: input.topicPartition,
        },
      },
      create: {
        consumerKey: input.consumerKey,
        topicPartition: input.topicPartition,
        lastOffset: BigInt(input.offset),
        lastEventId: input.eventId,
        lastEventAt: new Date(input.eventAt),
      },
      update: {
        lastOffset: BigInt(input.offset),
        lastEventId: input.eventId,
        lastEventAt: new Date(input.eventAt),
      },
    });
  }

  /** All positions for one consumer (worker boot: the resume map). */
  async positions(consumerKey: string): Promise<FeedCheckpointPosition[]> {
    const rows = await this.db.feedCheckpoint.findMany({ where: { consumerKey } });
    return rows.map((row) => ({
      topicPartition: row.topicPartition,
      offset: Number(row.lastOffset),
      eventId: row.lastEventId,
      eventAt: row.lastEventAt?.toISOString() ?? null,
    }));
  }

  /** Nightly reset: checkpoints are disposable (reseed starts from scratch). */
  async truncate(): Promise<number> {
    return this.db.feedCheckpoint.deleteMany({}).then((r) => r.count);
  }
}
