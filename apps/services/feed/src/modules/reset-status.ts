import { createLogger } from '@xitter/observability';
import { RESET_STATUS_KEY } from '@xitter/config';
import { resetStatusSchema, type ResetStatus } from '@xitter/api-contracts';

const logger = createLogger({ service: 'feed' });

/**
 * Reader for the reset job's run record (spec 03 internal table, T13): the
 * job writes the last run to Valkey after every attempt; this exposes it
 * for the admin health tile. Missing/unreadable values surface as null -
 * "no reset recorded" - never an error: the tile is informational.
 */
export interface ResetStatusReader {
  latest(): Promise<ResetStatus | null>;
  /** Release the connection at shutdown (no-op without one). */
  stop(): Promise<void>;
}

/** Injection token (string token so test doubles are easy to provide). */
export const RESET_STATUS = 'RESET_STATUS';

/** Structural slice of ioredis used here (unit-testable). */
interface RedisReader {
  get(key: string): Promise<string | null>;
  quit(): Promise<unknown>;
}

export class ValkeyResetStatus implements ResetStatusReader {
  private connection?: RedisReader;

  constructor(
    private readonly url: string,
    private readonly connectOverride?: () => Promise<RedisReader>,
  ) {}

  /** Test seam: inject a scripted connection. */
  useConnection(connection: RedisReader): void {
    this.connection = connection;
  }

  async latest(): Promise<ResetStatus | null> {
    try {
      const connection = await this.connect();
      const raw = await connection.get(RESET_STATUS_KEY);
      if (!raw) return null;
      return resetStatusSchema.parse(JSON.parse(raw));
    } catch (err) {
      logger.warn({ err }, 'reset status read failed');
      return null;
    }
  }

  async stop(): Promise<void> {
    await this.connection?.quit().catch(() => undefined);
  }

  private async connect(): Promise<RedisReader> {
    if (this.connection) return this.connection;
    if (this.connectOverride) {
      this.connection = await this.connectOverride();
      return this.connection;
    }
    const { Redis } = await import('ioredis');
    const connection = new Redis(this.url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2_000,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        connection.once('ready', () => resolve());
        connection.once('error', (err) => reject(err));
      });
    } catch (err) {
      connection.disconnect();
      throw err;
    }
    this.connection = connection;
    return this.connection;
  }
}
