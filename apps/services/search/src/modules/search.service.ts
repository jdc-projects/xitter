import { Injectable } from '@nestjs/common';

/**
 * Full-text search over posts.
 * Skeleton - OpenSearch indexing and querying land with the search feature
 * ticket.
 */
@Injectable()
export class SearchService {
  placeholder(): { items: unknown[]; nextCursor: string | null } {
    return { items: [], nextCursor: null };
  }
}
