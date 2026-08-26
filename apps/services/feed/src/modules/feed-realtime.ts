import { connectValkey, createLogger } from '@xitter/observability';

const logger = createLogger({ service: 'feed' });

/** Valkey pub/sub channel per user (spec 03/05: notifications only). */
export const feedChannel = (userId: string): string => `feed:updates:${userId}`;

/** Realtime notification seam: fan-out writes announce themselves. */
export interface FeedRealtime {
  /**
   * Best-effort notify - a lost notification is recovered by the next
   * refetch/poll (spec 03 delivery semantics), so failures log, not throw.
   */
  notify(userIds: string[]): Promise<void>;
  /** Release the pub/sub connection at shutdown (no-op without one). */
  stop?(): Promise<void>;
}

/** Injection token (string token so test doubles are easy to provide). */
export const FEED_REALTIME = 'FEED_REALTIME';

/** Structural slice of ioredis the publisher needs (unit-testable). */
interface RedisPublisher {
  publish(channel: string, message: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

/** Valkey-backed publisher: one connection per process. */
export class ValkeyFeedRealtime implements FeedRealtime {
  private connection?: RedisPublisher;

  constructor(
    private readonly url: string,
    /** Test seam: scripted connection factory (real wiring passes none). */
    private readonly connectOverride?: () => Promise<RedisPublisher>,
  ) {}

  async notify(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    try {
      const connection = await this.connect();
      await Promise.all(userIds.map((userId) => connection.publish(feedChannel(userId), '1')));
    } catch (err) {
      // A dead cached connection (Valkey restart / the reset's FLUSHALL)
      // must not wedge notifications until pod restart: drop the handle so
      // the next notify reconnects, then log-and-degrade as usual.
      const dead = this.connection;
      this.connection = undefined;
      dead?.quit().catch(() => undefined);
      logger.warn({ err }, 'feed update notification failed');
    }
  }

  async stop(): Promise<void> {
    await this.connection?.quit().catch(() => undefined);
  }

  private async connect(): Promise<RedisPublisher> {
    if (this.connection) return this.connection;
    // Same posture as the rate limiter: fail fast while Valkey is down -
    // notifications are a UX hint, never worth blocking a request on.
    // Handshake + leak-safety live in the shared connectValkey helper.
    this.connection = this.connectOverride
      ? await this.connectOverride()
      : await connectValkey({ url: this.url });
    return this.connection;
  }
}
