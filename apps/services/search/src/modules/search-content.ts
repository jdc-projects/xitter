import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PostsClient, SocialClient } from '@xitter/api-client';
import type { Post, Profile } from '@xitter/api-contracts';
import { createLogger } from '@xitter/observability';

const logger = createLogger({ service: 'search' });

/**
 * Server-side hydration seam for search results (spec 03): the index stores
 * ids + text only, the API joins post bodies (posts) and author profiles
 * (social) through their internal bulk-lookup endpoints - the same pattern
 * as the feed service's content-hydrator.
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

/**
 * Posts/social-backed hydration via their internal bulk-lookup endpoints,
 * authenticated with search's client-credentials token (audience svc-posts
 * / svc-social). Fails CLOSED: when either service cannot answer, the search
 * read 503s rather than serving results with holes - and block filtering
 * must never silently pass.
 */
@Injectable()
export class ServiceSearchContent implements SearchContentSource {
  private readonly postsClient: PostsClient;
  private readonly socialClient: SocialClient;

  constructor(options: {
    postsUrl: string;
    socialUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    fetchImpl?: typeof fetch;
  }) {
    const internal = {
      tokenUrl: options.tokenUrl,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
    };
    this.postsClient = new PostsClient({
      baseUrl: options.postsUrl,
      internal,
      fetchImpl: options.fetchImpl,
    });
    this.socialClient = new SocialClient({
      baseUrl: options.socialUrl,
      internal,
      fetchImpl: options.fetchImpl,
    });
  }

  async posts(postIds: string[]): Promise<Map<string, Post>> {
    if (postIds.length === 0) return new Map();
    try {
      const { items } = await this.postsClient.internalPosts(postIds);
      return new Map(items.map((post) => [post.id, post]));
    } catch (err) {
      logger.error({ err }, 'posts hydration lookup failed');
      throw unavailable();
    }
  }

  async profiles(userIds: string[]): Promise<Map<string, Profile>> {
    if (userIds.length === 0) return new Map();
    try {
      const { items } = await this.socialClient.internalProfiles(userIds);
      return new Map(items.map((profile) => [profile.id, profile]));
    } catch (err) {
      logger.error({ err }, 'social hydration lookup failed');
      throw unavailable();
    }
  }

  async blockedAuthorIds(userId: string): Promise<string[]> {
    try {
      return await this.socialClient.internalBlockedIds(userId);
    } catch (err) {
      logger.error({ err }, 'social blocked-ids lookup failed');
      throw unavailable();
    }
  }
}

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    error: { code: 'INTERNAL', message: 'Search content is temporarily unavailable' },
  });
}
