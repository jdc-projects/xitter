import { Injectable } from '@nestjs/common';
import { ServiceContentSource } from '@xitter/service-kit';
import type { Post, PostViewerState, Profile } from '@xitter/api-contracts';

/** Server-side hydration seam (spec 03: feed joins posts + social). */
export interface ContentHydrator {
  /** Visible posts by id; deleted/missing ids absent from the map. */
  posts(postIds: string[]): Promise<Map<string, Post>>;
  /** Profiles by id; missing ids absent from the map. */
  profiles(userIds: string[]): Promise<Map<string, Profile>>;
  /** Ids of authors the user has blocked (feed filtering). */
  blockedAuthorIds(userId: string): Promise<string[]>;
  /**
   * Viewer interaction flags (#157) - fails open by contract: flags are
   * presentation-only, so an outage yields an empty map, not a 503.
   */
  viewerState(userId: string, postIds: string[]): Promise<Map<string, PostViewerState>>;
}

/** Injection token (string token so test doubles are easy to provide). */
export const CONTENT_HYDRATOR = 'CONTENT_HYDRATOR';

/**
 * Posts/social-backed hydration via their internal bulk-lookup endpoints
 * (spec 03), authenticated with feed's client-credentials token (audience
 * svc-posts / svc-social). Fails CLOSED: when either service cannot answer,
 * the feed read 503s rather than serving a feed with holes punched in it by
 * an outage - and block filtering must never silently pass. The lookup
 * mechanics live in the shared @xitter/service-kit source.
 */
@Injectable()
export class ServiceContentHydrator extends ServiceContentSource implements ContentHydrator {
  constructor(options: {
    postsUrl: string;
    socialUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    fetchImpl?: typeof fetch;
  }) {
    super({ ...options, unavailableMessage: 'Feed content is temporarily unavailable' });
  }
}
