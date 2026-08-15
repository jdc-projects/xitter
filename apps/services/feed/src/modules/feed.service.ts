import { Injectable } from "@nestjs/common";

/**
 * Materialised home feeds and real-time feed updates.
 * Skeleton - feed reads, fanout ingestion, and the websocket gateway land with
 * the feed feature ticket.
 */
@Injectable()
export class FeedService {
  placeholder(): { items: unknown[]; nextCursor: string | null } {
    return { items: [], nextCursor: null };
  }
}
