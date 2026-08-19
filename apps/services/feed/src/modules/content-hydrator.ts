import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PostsClient, SocialClient } from '@xitter/api-client';
import type { Post, Profile } from '@xitter/api-contracts';
import { createLogger } from '@xitter/observability';

const logger = createLogger({ service: 'feed' });

/** Server-side hydration seam (spec 03: feed joins posts + social). */
export interface ContentHydrator {
  /** Visible posts by id; deleted/missing ids absent from the map. */
  posts(postIds: string[]): Promise<Map<string, Post>>;
  /** Profiles by id; missing ids absent from the map. */
  profiles(userIds: string[]): Promise<Map<string, Profile>>;
  /** Ids of authors the user has blocked (feed filtering). */
  blockedAuthorIds(userId: string): Promise<string[]>;
}

/** Injection token (string token so test doubles are easy to provide). */
export const CONTENT_HYDRATOR = 'CONTENT_HYDRATOR';

/**
 * Posts/social-backed hydration via their internal bulk-lookup endpoints
 * (spec 03), authenticated with feed's client-credentials token (audience
 * svc-posts / svc-social). Fails CLOSED: when either service cannot answer,
 * the feed read 503s rather than serving a feed with holes punched in it by
 * an outage - and block filtering must never silently pass.
 */
@Injectable()
export class ServiceContentHydrator implements ContentHydrator {
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
    error: { code: 'INTERNAL', message: 'Feed content is temporarily unavailable' },
  });
}
