import { localUrl } from '@xitter/config';
import {
  adminAuditPageSchema,
  adminFollowGraphSchema,
  adminHealthSchema,
  adminMediaPageSchema,
  adminPostPageSchema,
  adminUserPageSchema,
  createInteractionRequestSchema,
  createMediaUploadResponseSchema,
  feedPageSchema,
  hydratedFeedItemSchema,
  interactionSchema,
  internalMediaAssetSchema,
  mediaAssetSchema,
  mediaLookupResponseSchema,
  postLookupResponseSchema,
  postPageSchema,
  postSchema,
  profileLookupResponseSchema,
  profileSchema,
  profileWithCountsSchema,
  relationshipSchema,
  searchCheckpointPositionSchema,
  feedCheckpointPositionSchema,
  threadResponseSchema,
  viewerStateResponseSchema,
  type createPostRequestSchema,
  type createProfileRequestSchema,
  type updateProfileRequestSchema,
  type FeedCheckpointPosition,
  type FeedCheckpointPutRequest,
  type FeedEntryInput,
  type HydratedFeedItem,
  type InteractionKind,
  type InternalMediaAsset,
  type MediaAsset,
  type MediaVariantCore,
  type Post,
  type PostViewerState,
  type Profile,
  type ProfileWithCounts,
  type Relationship,
  type SearchCheckpointPosition,
  type SearchCheckpointPutRequest,
  type SearchIndexDocument,
  type ThreadResponse,
} from '@xitter/api-contracts';
import { z } from 'zod';
import { ServiceClient, type ServiceClientOptions } from './client.js';

const V1 = '/api';

function paginated<T>(schema: z.ZodType<T>) {
  return z.object({ items: z.array(schema), nextCursor: z.string().nullable() });
}

/** Drop undefined/empty entries so query strings stay clean. */
function cleanQuery(query: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(query).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

/**
 * Base URLs resolved from env-driven local ports; override with env in
 * deployed contexts. The localhost fallback is a LOCAL-ONLY convenience: in
 * a deployed pod it silently targets the pod itself and every call
 * ECONNREFUSEDs (#112). Enforcement therefore lives one layer up, at the
 * consumers' zod env schemas (the boot boundary) via @xitter/config's
 * crossServiceUrlSchema - required when XITTER_ENV is dev/prod, defaulted
 * locally (#113). No second enforcement layer here.
 */
export const localServiceUrls = () => ({
  social: process.env.XITTER_SOCIAL_URL ?? localUrl('social'),
  posts: process.env.XITTER_POSTS_URL ?? localUrl('posts'),
  media: process.env.XITTER_MEDIA_URL ?? localUrl('media'),
  feed: process.env.XITTER_FEED_URL ?? localUrl('feed'),
  search: process.env.XITTER_SEARCH_URL ?? localUrl('search'),
  keycloak: process.env.XITTER_KEYCLOAK_URL ?? localUrl('keycloak'),
});

export class SocialClient extends ServiceClient {
  constructor(options: ServiceClientOptions) {
    super({ ...options, baseUrl: options.baseUrl });
  }

  /** Idempotent upsert of the caller's own profile (`:id` = caller). */
  // fallow-ignore-next-line unused-class-member -- consumed by the web login callback (apps/web/src/app/api/auth/callback/route.ts)
  createProfile(
    userId: string,
    body: z.infer<typeof createProfileRequestSchema> = {},
  ): Promise<Profile> {
    return this.post(`${V1}/social/v1/profiles/${userId}`, body).then(profileSchema.parse);
  }

  getProfile(userId: string): Promise<ProfileWithCounts> {
    return this.get(`${V1}/social/v1/profiles/${userId}`).then(profileWithCountsSchema.parse);
  }

  getProfileByUsername(username: string): Promise<Profile> {
    return this.get(`${V1}/social/v1/profiles/username/${username}`).then(profileSchema.parse);
  }

  /** Update the caller's own profile (partial); other ids are rejected server-side. */
  updateProfile(
    userId: string,
    body: z.infer<typeof updateProfileRequestSchema>,
  ): Promise<Profile> {
    return this.patch(`${V1}/social/v1/profiles/${userId}`, body).then(profileSchema.parse);
  }

  follow(userId: string): Promise<void> {
    return this.post(`${V1}/social/v1/profiles/${userId}/follow`);
  }

  unfollow(userId: string): Promise<void> {
    return this.delete(`${V1}/social/v1/profiles/${userId}/follow`);
  }

  block(userId: string): Promise<void> {
    return this.post(`${V1}/social/v1/profiles/${userId}/block`);
  }

  unblock(userId: string): Promise<void> {
    return this.delete(`${V1}/social/v1/profiles/${userId}/block`);
  }

  getRelationship(userId: string): Promise<Relationship> {
    return this.get(`${V1}/social/v1/profiles/${userId}/relationship`).then(
      relationshipSchema.parse,
    );
  }

  getFollowing(
    userId: string,
    cursor?: string,
  ): Promise<{ items: Profile[]; nextCursor: string | null }> {
    return this.followList(`${V1}/social/v1/profiles/${userId}/following`, cursor);
  }

  getFollowers(
    userId: string,
    cursor?: string,
  ): Promise<{ items: Profile[]; nextCursor: string | null }> {
    return this.followList(`${V1}/social/v1/profiles/${userId}/followers`, cursor);
  }

  private followList(
    path: string,
    cursor?: string,
  ): Promise<{ items: Profile[]; nextCursor: string | null }> {
    return this.get(path, cursor ? { cursor } : undefined).then((r) =>
      paginated(profileSchema).parse(r),
    );
  }

  /** Internal (service-to-service): follower ids for feed fanout. */
  internalFollowerIds(userId: string): Promise<string[]> {
    return this.get(`${V1}/social/internal/users/${userId}/followers/ids`);
  }

  /** Internal: full relationship flags between two users (block enforcement). */
  // fallow-ignore-next-line unused-class-member -- consumed by posts (#5) + feed/search (#7/#9) block enforcement
  internalRelationship(userId: string, otherId: string): Promise<Relationship> {
    return this.get(`${V1}/social/internal/users/${userId}/relationships/${otherId}`).then(
      relationshipSchema.parse,
    );
  }

  /** Internal: ids the user has blocked (feed/search filtering). */
  // fallow-ignore-next-line unused-class-member -- consumed by feed/search filtering (#7/#9)
  internalBlockedIds(userId: string): Promise<string[]> {
    return this.get(`${V1}/social/internal/users/${userId}/blocked/ids`);
  }

  /** Internal: bulk profile lookup for server-side hydration (feed #7). */
  /** Internal (feed #7): bulk profile lookup for feed hydration. */
  // fallow-ignore-next-line unused-class-member -- consumed via the feed service's hydrator seam (apps/services/feed/src/modules/content-hydrator.ts)
  internalProfiles(userIds: string[]): Promise<{ items: Profile[] }> {
    return this.post(`${V1}/social/internal/profiles/lookup`, { userIds }).then(
      profileLookupResponseSchema.parse,
    );
  }

  // -- Internal admin (T10): machine path (svc-admin client credentials).
  // No in-repo caller yet - the panel fetches browser-direct and bruno covers
  // the HTTP pair - but every other internal endpoint ships with a typed
  // client method; ops tooling (#13+) consumes these.

  /** Admin: user list (profiles + graph counts), username filter. */
  // fallow-ignore-next-line unused-class-member -- typed machine path; ops tooling consumes when it lands
  internalAdminUsers(
    filters: { username?: string },
    cursor?: string,
    limit?: number,
  ): Promise<z.infer<typeof adminUserPageSchema>> {
    const query = cleanQuery({ ...filters, cursor, limit: limit?.toString() });
    return this.get(`${V1}/social/internal/admin/users`, query).then(adminUserPageSchema.parse);
  }

  /** Admin: one user's profile + counts + first pages of both directions. */
  // fallow-ignore-next-line unused-class-member -- typed machine path; ops tooling consumes when it lands
  internalAdminFollowGraph(userId: string): Promise<z.infer<typeof adminFollowGraphSchema>> {
    return this.get(`${V1}/social/internal/admin/users/${userId}/follow-graph`).then(
      adminFollowGraphSchema.parse,
    );
  }

  /** Admin: per-service health with Terminus detail. */
  // fallow-ignore-next-line unused-class-member -- typed machine path; ops tooling consumes when it lands
  internalAdminHealth(): Promise<z.infer<typeof adminHealthSchema>> {
    return this.get(`${V1}/social/internal/admin/health`).then(adminHealthSchema.parse);
  }
}

export class PostsClient extends ServiceClient {
  createPost(body: z.input<typeof createPostRequestSchema>): Promise<Post> {
    return this.post(`${V1}/posts/v1/posts`, body).then(postSchema.parse);
  }

  deletePost(postId: string): Promise<void> {
    return this.delete(`${V1}/posts/v1/posts/${postId}`);
  }

  getPost(postId: string): Promise<Post> {
    return this.get(`${V1}/posts/v1/posts/${postId}`).then(postSchema.parse);
  }

  getUserPosts(
    userId: string,
    cursor?: string,
  ): Promise<{ items: Post[]; nextCursor: string | null }> {
    return this.get(`${V1}/posts/v1/users/${userId}/posts`, cursor ? { cursor } : undefined).then(
      (r) => paginated(postSchema).parse(r),
    );
  }

  getReplies(
    postId: string,
    cursor?: string,
  ): Promise<{ items: Post[]; nextCursor: string | null }> {
    return this.get(`${V1}/posts/v1/posts/${postId}/replies`, cursor ? { cursor } : undefined).then(
      (r) => paginated(postSchema).parse(r),
    );
  }

  /**
   * The composed thread read (#152): ancestors, focus, and a depth-capped
   * nested reply tree. `cursor` pages more top-level replies (same keyset
   * as getReplies).
   */
  // fallow-ignore-next-line unused-class-member -- consumed by the web thread page (apps/web/src/app/(app)/post/[postId]/page.tsx)
  getThread(postId: string, cursor?: string): Promise<ThreadResponse> {
    return this.get(`${V1}/posts/v1/posts/${postId}/thread`, cursor ? { cursor } : undefined).then(
      threadResponseSchema.parse,
    );
  }

  createInteraction(
    postId: string,
    kind: InteractionKind,
  ): Promise<z.infer<typeof interactionSchema>> {
    return this.post(
      `${V1}/posts/v1/posts/${postId}/interactions`,
      createInteractionRequestSchema.parse({ kind }),
    ).then(interactionSchema.parse);
  }

  deleteInteraction(postId: string, kind: InteractionKind): Promise<void> {
    return this.delete(`${V1}/posts/v1/posts/${postId}/interactions/${kind}`);
  }

  getBookmarks(cursor?: string): Promise<{ items: Post[]; nextCursor: string | null }> {
    return this.get(`${V1}/posts/v1/bookmarks`, cursor ? { cursor } : undefined).then((r) =>
      paginated(postSchema).parse(r),
    );
  }

  /** Batched viewer flags (like/repost/bookmark) for list rendering (#8). */
  // fallow-ignore-next-line unused-class-member -- consumed by the web feed/detail/profile/bookmarks loaders (apps/web/src/lib/posts/server.ts, apps/web/src/app/(app)/feed/load-feed.ts)
  getViewerState(postIds: string[]): Promise<{ items: PostViewerState[] }> {
    return this.get(`${V1}/posts/v1/viewer-state`, { postIds: postIds.join(',') }).then(
      viewerStateResponseSchema.parse,
    );
  }

  /** Internal (feed #7): bulk visible-post lookup for feed hydration. */
  /** Internal (feed #7): bulk visible-post lookup for feed hydration. */
  // fallow-ignore-next-line unused-class-member -- consumed via the feed service's hydrator seam (apps/services/feed/src/modules/content-hydrator.ts)
  internalPosts(postIds: string[]): Promise<{ items: Post[] }> {
    return this.post(`${V1}/posts/internal/posts/lookup`, { postIds }).then(
      postLookupResponseSchema.parse,
    );
  }

  /** Internal (fanout worker #7): author timeline for the follow backfill. */
  // fallow-ignore-next-line unused-class-member -- consumed via the fanout worker's PostsApi seam (apps/workers/fanout/src/handlers.ts)
  internalGetAuthorPosts(
    authorId: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ items: Post[]; nextCursor: string | null }> {
    return this.post(`${V1}/posts/internal/posts/by-author`, { authorId, cursor, limit }).then(
      postPageSchema.parse,
    );
  }

  // -- Internal admin (T10): machine path (svc-admin client credentials). The
  // browser panel uses same-origin fetch through the edge instead.

  /** Admin: moderation list with author/text/deleted filters. */
  // fallow-ignore-next-line unused-class-member -- typed machine path; ops tooling consumes when it lands
  internalAdminPosts(
    filters: { authorId?: string; text?: string; deleted?: 'true' | 'false' },
    cursor?: string,
    limit?: number,
  ): Promise<{ items: Post[]; nextCursor: string | null }> {
    const query = cleanQuery({ ...filters, cursor, limit: limit?.toString() });
    return this.get(`${V1}/posts/internal/admin/posts`, query).then(adminPostPageSchema.parse);
  }

  /** Admin: soft (?hard=false) or hard moderation delete of any post. */
  // fallow-ignore-next-line unused-class-member -- typed machine path; ops tooling consumes when it lands
  internalAdminDeletePost(postId: string, hard = false): Promise<void> {
    return this.delete(`${V1}/posts/internal/admin/posts/${postId}?hard=${hard}`);
  }

  /** Admin: restore a soft-deleted post. */
  // fallow-ignore-next-line unused-class-member -- typed machine path; ops tooling consumes when it lands
  internalAdminRestorePost(postId: string): Promise<Post> {
    return this.post(`${V1}/posts/internal/admin/posts/${postId}/restore`).then(postSchema.parse);
  }

  /** Admin: moderation audit trail (posts data). */
  // fallow-ignore-next-line unused-class-member -- typed machine path; ops tooling consumes when it lands
  internalAdminAudit(cursor?: string): Promise<z.infer<typeof adminAuditPageSchema>> {
    return this.get(`${V1}/posts/internal/admin/audit`, cursor ? { cursor } : undefined).then(
      adminAuditPageSchema.parse,
    );
  }

  /** Admin: per-service health with Terminus detail. */
  // fallow-ignore-next-line unused-class-member -- typed machine path; ops tooling consumes when it lands
  internalAdminHealth(): Promise<z.infer<typeof adminHealthSchema>> {
    return this.get(`${V1}/posts/internal/admin/health`).then(adminHealthSchema.parse);
  }
}

export class FeedClient extends ServiceClient {
  /** Page 1 or cursor walk of the caller's materialised, hydrated feed. */
  getFeed(cursor?: string, limit?: number): Promise<FeedPage> {
    const query: Record<string, string> = {};
    if (cursor) query.cursor = cursor;
    if (limit !== undefined) query.limit = String(limit);
    return this.get(`${V1}/feed/v1/feed`, query).then(feedPageSchema.parse);
  }

  /** Internal (fanout worker): bulk idempotent entry upsert. */
  // fallow-ignore-next-line unused-class-member -- consumed via the fanout worker's FeedApi seam (apps/workers/fanout/src/handlers.ts)
  internalUpsertEntries(entries: FeedEntryInput[]): Promise<{ inserted: number }> {
    return this.post(`${V1}/feed/internal/feed/entries`, { entries }).then((r) =>
      z.object({ inserted: z.number().int() }).parse(r),
    );
  }

  /** Internal (fanout worker): drop one post from every feed (post deleted). */
  // fallow-ignore-next-line unused-class-member -- consumed via the fanout worker's FeedApi seam (apps/workers/fanout/src/handlers.ts)
  internalDeletePostEntries(postId: string): Promise<{ deleted: number }> {
    return this.delete(`${V1}/feed/internal/feed/posts/${postId}/entries`).then((r) =>
      z.object({ deleted: z.number().int() }).parse(r),
    );
  }

  /** Internal (fanout worker): drop one reposter's repost entries (undo #8). */
  // fallow-ignore-next-line unused-class-member -- consumed via the fanout worker's FeedApi seam (apps/workers/fanout/src/handlers.ts)
  internalDeleteRepostEntries(postId: string, repostedById: string): Promise<{ deleted: number }> {
    return this.delete(`${V1}/feed/internal/feed/posts/${postId}/reposts/${repostedById}`).then(
      (r) => z.object({ deleted: z.number().int() }).parse(r),
    );
  }

  /** Internal (fanout worker): drop an author's entries from one feed (unfollow). */
  // fallow-ignore-next-line unused-class-member -- consumed via the fanout worker's FeedApi seam (apps/workers/fanout/src/handlers.ts)
  internalDeleteAuthorEntries(userId: string, authorId: string): Promise<{ deleted: number }> {
    return this.delete(`${V1}/feed/internal/feed/users/${userId}/authors/${authorId}`).then((r) =>
      z.object({ deleted: z.number().int() }).parse(r),
    );
  }

  /** Internal (reset job / fanout): wipe one user's feed. */
  // fallow-ignore-next-line unused-class-member -- consumed by the nightly reset job (#13) per spec 03
  internalResetUser(userId: string): Promise<{ deleted: number }> {
    return this.delete(`${V1}/feed/internal/feed/users/${userId}`).then((r) =>
      z.object({ deleted: z.number().int() }).parse(r),
    );
  }

  /** Internal (fanout worker): persist the last processed position (#149). */
  // fallow-ignore-next-line unused-class-member -- consumed via the fanout worker's FeedApi seam (apps/workers/fanout/src/handlers.ts)
  internalPutCheckpoint(body: FeedCheckpointPutRequest): Promise<void> {
    return this.post(`${V1}/feed/internal/feed/checkpoint`, body);
  }

  /** Internal (fanout worker boot): resume positions for a consumer (#149). */
  // fallow-ignore-next-line unused-class-member -- consumed via the fanout worker's boot path (apps/workers/fanout/src/main.ts)
  internalGetCheckpoints(consumerKey: string): Promise<{ positions: FeedCheckpointPosition[] }> {
    return this.get(`${V1}/feed/internal/feed/checkpoint`, { consumerKey }).then((r) =>
      z.object({ positions: z.array(feedCheckpointPositionSchema) }).parse(r),
    );
  }
}

export interface FeedPage {
  items: HydratedFeedItem[];
  nextCursor: string | null;
}

export class SearchClient extends ServiceClient {
  /** Cursor-paginated full-text post search (user token). */
  searchPosts(
    q: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ items: HydratedFeedItem[]; nextCursor: string | null }> {
    const query: Record<string, string> = { q };
    if (cursor) query.cursor = cursor;
    if (limit !== undefined) query.limit = String(limit);
    return this.get(`${V1}/search/v1/posts`, query).then((r) =>
      paginated(hydratedFeedItemSchema).parse(r),
    );
  }

  /** Internal (search-index worker): bulk index upsert; tombstones included. */
  // fallow-ignore-next-line unused-class-member -- consumed via the search-index worker's SearchApi seam (apps/workers/search-index/src/handlers.ts)
  internalUpsertDocuments(documents: SearchIndexDocument[]): Promise<{ indexed: number }> {
    return this.post(`${V1}/search/internal/search/index`, { documents }).then((r) =>
      z.object({ indexed: z.number().int().nonnegative() }).parse(r),
    );
  }

  /** Internal (search-index worker): refresh denormalised author names. */
  // fallow-ignore-next-line unused-class-member -- consumed via the search-index worker's SearchApi seam (apps/workers/search-index/src/handlers.ts)
  internalRefreshAuthors(
    authors: { authorId: string; authorName: string }[],
  ): Promise<{ updated: number }> {
    return this.post(`${V1}/search/internal/search/index/authors`, { authors }).then((r) =>
      z.object({ updated: z.number().int().nonnegative() }).parse(r),
    );
  }

  /** Internal (reset job): clear the posts index (docs only, mapping stays). */
  // fallow-ignore-next-line unused-class-member -- consumed by the nightly reset job (#13) per spec 03
  internalClearIndex(): Promise<{ deleted: number }> {
    return this.delete(`${V1}/search/internal/search/index`).then((r) =>
      z.object({ deleted: z.number().int().nonnegative() }).parse(r),
    );
  }

  /** Internal (search-index worker): persist the last processed position. */
  // fallow-ignore-next-line unused-class-member -- consumed via the search-index worker's checkpoint seam (apps/workers/search-index/src/checkpoints.ts)
  internalPutCheckpoint(body: SearchCheckpointPutRequest): Promise<void> {
    return this.post(`${V1}/search/internal/search/checkpoint`, body);
  }

  /** Internal (search-index worker boot): resume positions for a consumer. */
  // fallow-ignore-next-line unused-class-member -- consumed via the search-index worker's checkpoint seam (apps/workers/search-index/src/main.ts)
  internalGetCheckpoints(consumerKey: string): Promise<{ positions: SearchCheckpointPosition[] }> {
    return this.get(`${V1}/search/internal/search/checkpoint`, { consumerKey }).then((r) =>
      z.object({ positions: z.array(searchCheckpointPositionSchema) }).parse(r),
    );
  }
}

export class MediaClient extends ServiceClient {
  createUpload(body: {
    mimeType: string;
    bytes: number;
  }): Promise<{ mediaId: string; uploadUrl: string }> {
    return this.post(`${V1}/media/v1/uploads`, body).then(createMediaUploadResponseSchema.parse);
  }

  /** Client callback after the browser PUT; server-side HEAD-verified. */
  completeUpload(mediaId: string): Promise<MediaAsset> {
    return this.post(`${V1}/media/v1/media/${mediaId}/complete`).then(mediaAssetSchema.parse);
  }

  /** Metadata incl. variant URLs under `/media` (rendering + polling). */
  getMedia(mediaId: string): Promise<MediaAsset> {
    return this.get(`${V1}/media/v1/media/${mediaId}`).then(mediaAssetSchema.parse);
  }

  /** Internal (media-process worker): current asset state. */
  internalGetAsset(mediaId: string): Promise<InternalMediaAsset> {
    return this.get(`${V1}/media/internal/media/${mediaId}`).then(internalMediaAssetSchema.parse);
  }

  /** Internal (media-process worker): record variants → ready (idempotent). */
  internalRecordVariants(mediaId: string, variants: MediaVariantCore[]): Promise<MediaAsset> {
    return this.post(`${V1}/media/internal/media/${mediaId}/variants`, { variants }).then(
      mediaAssetSchema.parse,
    );
  }

  /** Internal (media-process worker): failed attempt (service owns the cap). */
  internalReportFailure(mediaId: string, error: string): Promise<MediaAsset> {
    return this.post(`${V1}/media/internal/media/${mediaId}/failure`, { error }).then(
      mediaAssetSchema.parse,
    );
  }

  /** Internal (posts): owned assets among the ids (attach validation). */
  internalLookup(
    ownerId: string,
    mediaIds: string[],
    altTexts?: Record<string, string>,
  ): Promise<{ items: MediaAsset[] }> {
    // altTexts only ride the wire when at least one is set - a bare lookup
    // stays byte-identical to the historical shape.
    const body =
      altTexts && Object.keys(altTexts).length > 0
        ? { ownerId, mediaIds, altTexts }
        : { ownerId, mediaIds };
    return this.post(`${V1}/media/internal/media/lookup`, body).then(
      mediaLookupResponseSchema.parse,
    );
  }

  // -- Internal admin (T10): machine path (svc-admin client credentials).

  /** Admin: moderation list with owner/status filters (internal view). */
  // fallow-ignore-next-line unused-class-member -- typed machine path; ops tooling consumes when it lands
  internalAdminMedia(
    filters: { ownerId?: string; status?: 'pending' | 'ready' | 'failed' },
    cursor?: string,
    limit?: number,
  ): Promise<z.infer<typeof adminMediaPageSchema>> {
    const query = cleanQuery({ ...filters, cursor, limit: limit?.toString() });
    return this.get(`${V1}/media/internal/admin/media`, query).then(adminMediaPageSchema.parse);
  }

  /** Admin: delete an asset (row + RustFS objects cascade). */
  // fallow-ignore-next-line unused-class-member -- typed machine path; ops tooling consumes when it lands
  internalAdminDeleteMedia(mediaId: string): Promise<void> {
    return this.delete(`${V1}/media/internal/admin/media/${mediaId}`);
  }

  /** Admin: moderation audit trail (media data). */
  // fallow-ignore-next-line unused-class-member -- typed machine path; ops tooling consumes when it lands
  internalAdminAudit(cursor?: string): Promise<z.infer<typeof adminAuditPageSchema>> {
    return this.get(`${V1}/media/internal/admin/audit`, cursor ? { cursor } : undefined).then(
      adminAuditPageSchema.parse,
    );
  }

  /** Admin: per-service health with Terminus detail. */
  // fallow-ignore-next-line unused-class-member -- typed machine path; ops tooling consumes when it lands
  internalAdminHealth(): Promise<z.infer<typeof adminHealthSchema>> {
    return this.get(`${V1}/media/internal/admin/health`).then(adminHealthSchema.parse);
  }
}

export interface ServiceClients {
  social: SocialClient;
  posts: PostsClient;
  feed: FeedClient;
  search: SearchClient;
  media: MediaClient;
}

/** Build all clients against local (default) or env-overridden service URLs. */
export function createServiceClients(token?: string): ServiceClients {
  const urls = localServiceUrls();
  return {
    social: new SocialClient({ baseUrl: urls.social, token }),
    posts: new PostsClient({ baseUrl: urls.posts, token }),
    feed: new FeedClient({ baseUrl: urls.feed, token }),
    search: new SearchClient({ baseUrl: urls.search, token }),
    media: new MediaClient({ baseUrl: urls.media, token }),
  };
}
