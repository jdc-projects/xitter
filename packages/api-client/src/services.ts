import { localUrl } from '@xitter/config';
import {
  createInteractionRequestSchema,
  createMediaUploadResponseSchema,
  feedPageSchema,
  internalMediaAssetSchema,
  mediaAssetSchema,
  mediaLookupResponseSchema,
  postSchema,
  profileSchema,
  profileWithCountsSchema,
  relationshipSchema,
  type createPostRequestSchema,
  type createProfileRequestSchema,
  type updateProfileRequestSchema,
  type InteractionKind,
  type InternalMediaAsset,
  type MediaAsset,
  type MediaVariantCore,
  type Post,
  type Profile,
  type ProfileWithCounts,
  type Relationship,
} from '@xitter/api-contracts';
import { z } from 'zod';
import { ServiceClient, type ServiceClientOptions } from './client.js';

const V1 = '/api';

function paginated<T>(schema: z.ZodType<T>) {
  return z.object({ items: z.array(schema), nextCursor: z.string().nullable() });
}

/** Base URLs resolved from env-driven local ports; override with env in deployed contexts. */
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

  createInteraction(postId: string, kind: InteractionKind): Promise<void> {
    return this.post(
      `${V1}/posts/v1/posts/${postId}/interactions`,
      createInteractionRequestSchema.parse({ kind }),
    );
  }

  deleteInteraction(postId: string, kind: InteractionKind): Promise<void> {
    return this.delete(`${V1}/posts/v1/posts/${postId}/interactions/${kind}`);
  }

  getBookmarks(cursor?: string): Promise<{ items: Post[]; nextCursor: string | null }> {
    return this.get(`${V1}/posts/v1/bookmarks`, cursor ? { cursor } : undefined).then((r) =>
      paginated(postSchema).parse(r),
    );
  }
}

export class FeedClient extends ServiceClient {
  getFeed(cursor?: string): Promise<unknown> {
    return this.get(`${V1}/feed/v1/feed`, cursor ? { cursor } : undefined).then(
      feedPageSchema.parse,
    );
  }
}

export class SearchClient extends ServiceClient {
  searchPosts(q: string, cursor?: string): Promise<unknown> {
    return this.get(`${V1}/search/v1/posts`, { q, ...(cursor ? { cursor } : {}) });
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
  internalLookup(ownerId: string, mediaIds: string[]): Promise<{ items: MediaAsset[] }> {
    return this.post(`${V1}/media/internal/media/lookup`, { ownerId, mediaIds }).then(
      mediaLookupResponseSchema.parse,
    );
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
