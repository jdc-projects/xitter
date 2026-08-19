import { Inject, Injectable } from '@nestjs/common';
import type { SearchCheckpointPosition } from '@xitter/api-contracts';
import type { PrismaClient, Prisma } from '../generated/prisma/client.js';

/** DI token for the service-owned Prisma client (tests provide their own). */
export const SEARCH_PRISMA = 'SEARCH_PRISMA';

export type SearchPrismaClient = PrismaClient & { $disconnect(): Promise<void> };

export type SearchDb = Pick<PrismaClient, 'searchCheckpoint'>;

export type CheckpointInput = {
  consumerKey: string;
  topicPartition: string;
  offset: number;
  eventId: string;
  eventAt: string;
};

/**
 * Prisma data access for the search-index worker's resume positions
 * (SearchCheckpoint, spec 05). One row per (consumer, topic-partition),
 * upserted after every processed message - a wiped consumer group resumes
 * here instead of at the log end.
 */
@Injectable()
export class CheckpointRepository {
  constructor(@Inject(SEARCH_PRISMA) private readonly db: SearchDb) {}

  /** Idempotent position upsert (last-write-wins by processed offset). */
  async report(input: CheckpointInput): Promise<void> {
    await this.db.searchCheckpoint.upsert({
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
  async positions(consumerKey: string): Promise<SearchCheckpointPosition[]> {
    const rows = await this.db.searchCheckpoint.findMany({ where: { consumerKey } });
    return rows.map((row) => ({
      topicPartition: row.topicPartition,
      offset: Number(row.lastOffset),
      eventId: row.lastEventId,
      eventAt: row.lastEventAt?.toISOString() ?? null,
    }));
  }

  /** Nightly reset: checkpoints are disposable (reseed starts from scratch). */
  async truncate(): Promise<number> {
    return this.db.searchCheckpoint.deleteMany({}).then((r) => r.count);
  }
}

/** Prisma input type re-export for the module factory. */
export type { Prisma };
