import { PostsClient, SocialClient } from '@xitter/api-client';
import type { Post, PostViewerState, Profile } from '@xitter/api-contracts';
import { createLogger } from '@xitter/observability';
import { ServiceUnavailableException } from '@nestjs/common';

const logger = createLogger({ service: 'content-hydrator' });

export interface ServiceContentOptions {
  postsUrl: string;
  socialUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  /** Caller-identifying message for the 503 (e.g. 'Feed content ...'). */
  unavailableMessage: string;
}

/**
 * Posts/social-backed hydration via their internal bulk-lookup endpoints,
 * authenticated with the calling service's client-credentials token
 * (audience svc-posts / svc-social). Fails CLOSED: when either service
 * cannot answer, the read 503s rather than serving results with holes -
 * and block filtering must never silently pass. Shared by every read model
 * that hydrates post bodies + author profiles (feed, search).
 */
export class ServiceContentSource {
  protected readonly postsClient: PostsClient;
  protected readonly socialClient: SocialClient;
  private readonly unavailableMessage: string;

  constructor(options: ServiceContentOptions) {
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
    this.unavailableMessage = options.unavailableMessage;
  }

  async posts(postIds: string[]): Promise<Map<string, Post>> {
    if (postIds.length === 0) return new Map();
    try {
      const { items } = await this.postsClient.internalPosts(postIds);
      return new Map(items.map((post) => [post.id, post]));
    } catch (err) {
      logger.error({ err }, 'posts hydration lookup failed');
      throw this.unavailable();
    }
  }

  async profiles(userIds: string[]): Promise<Map<string, Profile>> {
    if (userIds.length === 0) return new Map();
    try {
      const { items } = await this.socialClient.internalProfiles(userIds);
      return new Map(items.map((profile) => [profile.id, profile]));
    } catch (err) {
      logger.error({ err }, 'social hydration lookup failed');
      throw this.unavailable();
    }
  }

  /**
   * Viewer interaction flags by user id (#157). FAILS OPEN, unlike the
   * hydration lookups: flags are presentation-only (filled vs un-filled
   * cards), so a posts outage must not 503 the feed - callers get an empty
   * map and render un-filled, the same contract the web's separate hop had.
   */
  // fallow-ignore-next-line unused-class-member -- consumed through the ContentHydrator interface (duck-typed inject)
  async viewerState(userId: string, postIds: string[]): Promise<Map<string, PostViewerState>> {
    if (postIds.length === 0) return new Map();
    try {
      const { items } = await this.postsClient.internalViewerState(userId, postIds);
      return new Map(items.map((state) => [state.postId, state]));
    } catch (err) {
      logger.warn({ err }, 'posts viewer-state lookup failed (best-effort)');
      return new Map();
    }
  }

  async blockedAuthorIds(userId: string): Promise<string[]> {
    try {
      return await this.socialClient.internalBlockedIds(userId);
    } catch (err) {
      logger.error({ err }, 'social blocked-ids lookup failed');
      throw this.unavailable();
    }
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      error: { code: 'INTERNAL', message: this.unavailableMessage },
    });
  }
}
