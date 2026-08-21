import { feedUpdatesChannel } from '@xitter/api-contracts';
import { connectValkey, createLogger } from '@xitter/observability';

const logger = createLogger({ service: 'posts' });

/**
 * Author-ping seam (#8, product 5.5): a new like/repost of a post pings the
 * author over the feed ws channel WITHOUT creating feed entries - the
 * notification is the interaction's whole realtime footprint (spec 03:
 * notifications only, no data push). Bookmarks never ping (privacy: the
 * author must not learn who bookmarked).
 */
export interface InteractionRealtime {
  /** Best-effort ping - failures log, never fail the interaction. */
  notifyAuthor(authorId: string): Promise<void>;
  /** Release the pub/sub connection at shutdown (no-op without one). */
  stop?(): Promise<void>;
}

/** Injection token (string token so test doubles are easy to provide). */
export const INTERACTION_REALTIME = 'INTERACTION_REALTIME';

/** Inert publisher for tests and contexts without a Valkey dependency. */
export class NullInteractionRealtime implements InteractionRealtime {
  notifyAuthor(): Promise<void> {
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

/** Structural slice of ioredis the publisher needs (unit-testable). */
interface RedisPublisher {
  publish(channel: string, message: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

/**
 * Valkey-backed publisher: one connection per process, same posture as the
 * feed service's realtime seam. Publishing from posts (rather than routing
 * through the fanout worker) keeps the ping on the interaction's own commit
 * path - no Kafka round-trip or consumer lag between a like and the author's
 * banner.
 */
export class ValkeyInteractionRealtime implements InteractionRealtime {
  private connection?: RedisPublisher;

  constructor(private readonly url: string) {}

  async notifyAuthor(authorId: string): Promise<void> {
    try {
      const connection = await this.connect();
      await connection.publish(feedUpdatesChannel(authorId), '1');
    } catch (err) {
      logger.warn({ err }, 'author interaction notification failed');
    }
  }

  async stop(): Promise<void> {
    await this.connection?.quit().catch(() => undefined);
  }

  private async connect(): Promise<RedisPublisher> {
    if (this.connection) return this.connection;
    // Same posture as the rate limiter: never block an interaction on a
    // degraded Valkey - handshake + leak-safety live in connectValkey.
    this.connection = await connectValkey({ url: this.url });
    return this.connection;
  }
}
