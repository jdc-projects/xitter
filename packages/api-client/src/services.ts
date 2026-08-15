import { localUrl } from "@xitter/config";
import {
  createInteractionRequestSchema,
  createPostRequestSchema,
  feedPageSchema,
  postSchema,
  profileSchema,
  relationshipSchema,
  updateProfileRequestSchema,
  type InteractionKind,
  type Post,
  type Profile,
  type Relationship,
} from "@xitter/api-contracts";
import { z } from "zod";
import { ServiceClient, type ServiceClientOptions } from "./client.js";

const V1 = "/api";

function paginated<T>(schema: z.ZodType<T>) {
  return z.object({ items: z.array(schema), nextCursor: z.string().nullable() });
}

/** Base URLs resolved from env-driven local ports; override with env in deployed contexts. */
export const localServiceUrls = () => ({
  social: process.env.XITTER_SOCIAL_URL ?? localUrl("social"),
  posts: process.env.XITTER_POSTS_URL ?? localUrl("posts"),
  media: process.env.XITTER_MEDIA_URL ?? localUrl("media"),
  feed: process.env.XITTER_FEED_URL ?? localUrl("feed"),
  search: process.env.XITTER_SEARCH_URL ?? localUrl("search"),
  keycloak: process.env.XITTER_KEYCLOAK_URL ?? localUrl("keycloak"),
});

export class SocialClient extends ServiceClient {
  constructor(options: ServiceClientOptions) {
    super({ ...options, baseUrl: options.baseUrl });
  }

  getProfile(userId: string): Promise<Profile> {
    return this.get(`${V1}/social/v1/profiles/${userId}`).then(profileSchema.parse);
  }

  getProfileByUsername(username: string): Promise<Profile> {
    return this.get(`${V1}/social/v1/profiles/username/${username}`).then(profileSchema.parse);
  }

  updateProfile(userId: string, body: z.infer<typeof updateProfileRequestSchema>): Promise<Profile> {
    return this.post(`${V1}/social/v1/profiles/${userId}`, body).then(profileSchema.parse);
  }

  follow(userId: string): Promise<void> {
    return this.post(`${V1}/social/v1/users/${userId}/follow`);
  }

  unfollow(userId: string): Promise<void> {
    return this.delete(`${V1}/social/v1/users/${userId}/follow`);
  }

  block(userId: string): Promise<void> {
    return this.post(`${V1}/social/v1/users/${userId}/block`);
  }

  unblock(userId: string): Promise<void> {
    return this.delete(`${V1}/social/v1/users/${userId}/block`);
  }

  getRelationship(userId: string): Promise<Relationship> {
    return this.get(`${V1}/social/v1/users/${userId}/relationship`).then(relationshipSchema.parse);
  }

  getFollowing(userId: string, cursor?: string): Promise<{ items: Profile[]; nextCursor: string | null }> {
    return this.get(`${V1}/social/v1/users/${userId}/following`, cursor ? { cursor } : undefined)
      .then((r) => paginated(profileSchema).parse(r));
  }

  getFollowers(userId: string, cursor?: string): Promise<{ items: Profile[]; nextCursor: string | null }> {
    return this.get(`${V1}/social/v1/users/${userId}/followers`, cursor ? { cursor } : undefined)
      .then((r) => paginated(profileSchema).parse(r));
  }

  /** Internal (service-to-service): follower ids for feed fanout. */
  internalFollowerIds(userId: string): Promise<string[]> {
    return this.get(`${V1}/social/v1/internal/users/${userId}/followers/ids`);
  }
}

export class PostsClient extends ServiceClient {
  createPost(body: z.infer<typeof createPostRequestSchema>): Promise<Post> {
    return this.post(`${V1}/posts/v1/posts`, body).then(postSchema.parse);
  }

  deletePost(postId: string): Promise<void> {
    return this.delete(`${V1}/posts/v1/posts/${postId}`);
  }

  getPost(postId: string): Promise<Post> {
    return this.get(`${V1}/posts/v1/posts/${postId}`).then(postSchema.parse);
  }

  getUserPosts(userId: string, cursor?: string): Promise<{ items: { post: Post; author: Profile }[]; nextCursor: string | null }> {
    return this.get(`${V1}/posts/v1/users/${userId}/posts`, cursor ? { cursor } : undefined)
      .then((r) => paginated(z.object({ post: postSchema, author: profileSchema })).parse(r));
  }

  getReplies(postId: string, cursor?: string): Promise<{ items: { post: Post; author: Profile }[]; nextCursor: string | null }> {
    return this.get(`${V1}/posts/v1/posts/${postId}/replies`, cursor ? { cursor } : undefined)
      .then((r) => paginated(z.object({ post: postSchema, author: profileSchema })).parse(r));
  }

  createInteraction(postId: string, kind: InteractionKind): Promise<void> {
    return this.post(`${V1}/posts/v1/posts/${postId}/interactions`, createInteractionRequestSchema.parse({ kind }));
  }

  deleteInteraction(postId: string, kind: InteractionKind): Promise<void> {
    return this.delete(`${V1}/posts/v1/posts/${postId}/interactions/${kind}`);
  }

  getBookmarks(cursor?: string): Promise<{ items: { post: Post; author: Profile }[]; nextCursor: string | null }> {
    return this.get(`${V1}/posts/v1/bookmarks`, cursor ? { cursor } : undefined)
      .then((r) => paginated(z.object({ post: postSchema, author: profileSchema })).parse(r));
  }
}

export class FeedClient extends ServiceClient {
  getFeed(cursor?: string): Promise<unknown> {
    return this.get(`${V1}/feed/v1/feed`, cursor ? { cursor } : undefined).then(feedPageSchema.parse);
  }
}

export class SearchClient extends ServiceClient {
  searchPosts(q: string, cursor?: string): Promise<unknown> {
    return this.get(`${V1}/search/v1/posts`, { q, ...(cursor ? { cursor } : {}) });
  }
}

export class MediaClient extends ServiceClient {
  createUpload(body: { mimeType: string; bytes: number }): Promise<{ mediaId: string; uploadUrl: string }> {
    return this.post(`${V1}/media/v1/uploads`, body);
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
