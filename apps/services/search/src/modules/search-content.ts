import { Injectable } from '@nestjs/common';
import { ServiceContentSource } from '@xitter/service-kit';
import type { Post, Profile } from '@xitter/api-contracts';

/**
 * Server-side hydration seam for search results (spec 03): the index stores
 * ids + text only, the API joins post bodies (posts) and author profiles
 * (social) through their internal bulk-lookup endpoints. Fails CLOSED on
 * upstream outages. The lookup mechanics live in the shared
 * @xitter/service-kit source.
 */
export interface SearchContentSource {
  /** Visible posts by id; deleted/missing ids absent from the map. */
  posts(postIds: string[]): Promise<Map<string, Post>>;
  /** Profiles by id; missing ids absent from the map. */
  profiles(userIds: string[]): Promise<Map<string, Profile>>;
  /** Ids of authors the viewer has blocked (query-level filtering). */
  blockedAuthorIds(userId: string): Promise<string[]>;
}

/** Injection token (string token so test doubles are easy to provide). */
export const SEARCH_CONTENT = 'SEARCH_CONTENT';

@Injectable()
export class ServiceSearchContent extends ServiceContentSource implements SearchContentSource {
  constructor(options: {
    postsUrl: string;
    socialUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    fetchImpl?: typeof fetch;
  }) {
    super({ ...options, unavailableMessage: 'Search content is temporarily unavailable' });
  }
}
