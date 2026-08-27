import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

export const userIdSchema = z.uuid().openapi({ example: 'b1c2d3e4-0000-4000-8000-000000000001' });
export const postIdSchema = z.uuid().openapi({ example: 'b1c2d3e4-0000-4000-8000-000000000002' });
export const mediaIdSchema = z.uuid();

export const usernameSchema = z
  .string()
  .min(3)
  .max(20)
  .regex(/^[a-z0-9_]+$/, 'lowercase alphanumeric and underscore only');

/** Product limit: max 512 characters of text per post. */
export const POST_TEXT_MAX = 512;
/** Product limit: max 5MB per uploaded image. */
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;
/** Max images attached to a single post (matches the demo UI). */
export const POST_MEDIA_MAX = 4;
/** Product limit: max 200 characters of alt text per attached image (#133). */
export const MEDIA_ALT_TEXT_MAX = 200;

/**
 * Author-supplied alt text for one attached image (#133): trimmed, then
 * either a non-empty string or absent entirely - a blank/whitespace value
 * never reaches storage (clients omit the field instead).
 */
export const mediaAltTextInputSchema = z.string().trim().min(1).max(MEDIA_ALT_TEXT_MAX);

export type MediaAltTextInput = z.infer<typeof mediaAltTextInputSchema>;

export const profileSchema = z.object({
  id: userIdSchema,
  username: usernameSchema,
  displayName: z.string().min(1).max(50),
  bio: z.string().max(200).nullable(),
  createdAt: z.iso.datetime(),
});

export type Profile = z.infer<typeof profileSchema>;

export const profileCountsSchema = z.object({
  following: z.number().int().nonnegative(),
  followers: z.number().int().nonnegative(),
});

/** Profile as returned by `GET /profiles/:id` (spec 03: profile + counts). */
export const profileWithCountsSchema = profileSchema.extend({
  counts: profileCountsSchema,
});

export type ProfileWithCounts = z.infer<typeof profileWithCountsSchema>;

/** Variant record as reported by the media-process worker (no derived url). */
export const mediaVariantCoreSchema = z.object({
  kind: z.enum(['original', 'thumb']),
  objectKey: z.string().min(1),
  mimeType: z.string().min(1),
  bytes: z.number().int().positive(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});

export type MediaVariantCore = z.infer<typeof mediaVariantCoreSchema>;

/** Variant as served by the media API: core fields + edge URL at `/media/{key}`. */
export const mediaVariantSchema = mediaVariantCoreSchema.extend({
  url: z.string().min(1),
});

export type MediaVariant = z.infer<typeof mediaVariantSchema>;

/**
 * Media asset as served by media/posts: `altText` is optional + nullable
 * so legacy snapshots (taken before #133) and alt-less assets both parse -
 * readers fall back to a generic description when it is absent/empty.
 */
export const mediaAssetSchema = z.object({
  id: mediaIdSchema,
  ownerId: userIdSchema,
  status: z.enum(['pending', 'ready', 'failed']),
  variants: z.array(mediaVariantSchema),
  altText: z.string().max(MEDIA_ALT_TEXT_MAX).nullable().optional(),
  createdAt: z.iso.datetime(),
});

export type MediaAsset = z.infer<typeof mediaAssetSchema>;

/**
 * Internal asset view (media ↔ workers/posts): everything the public asset
 * carries plus the storage coordinates and lifecycle counters the public
 * contract deliberately omits.
 */
export const internalMediaAssetSchema = mediaAssetSchema.extend({
  objectKey: z.string().min(1),
  mimeType: z.string().min(1),
  bytes: z.number().int().positive(),
  attempts: z.number().int().nonnegative(),
});

export type InternalMediaAsset = z.infer<typeof internalMediaAssetSchema>;

export const postCountsSchema = z.object({
  replies: z.number().int().nonnegative(),
  likes: z.number().int().nonnegative(),
  reposts: z.number().int().nonnegative(),
});

export const postSchema = z.object({
  id: postIdSchema,
  authorId: userIdSchema,
  text: z.string().min(1).max(POST_TEXT_MAX),
  media: z.array(mediaAssetSchema),
  replyToId: postIdSchema.nullable(),
  repostOfId: postIdSchema.nullable(),
  counts: postCountsSchema,
  createdAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

export type Post = z.infer<typeof postSchema>;

// Thread-view tunables (#152). Product constants, not per-request knobs: the
// endpoint shape (how deep `replies` nests, how many children preview per
// node, how far the ancestor walk goes) is fixed so clients can reason about
// a bounded payload; deep conversation is reached by navigation, not larger
// responses.
/** Max ancestors returned by the thread endpoint (root → parent chain cap). */
export const THREAD_ANCESTORS_MAX = 25;
/** Max nesting depth of `replies` nodes below the focus post. */
export const THREAD_DEPTH_MAX = 3;
/** Children embedded per tree node beyond the top-level page limit. */
export const THREAD_CHILDREN_PREVIEW = 2;

export interface ThreadNode {
  post: Post;
  /** Preview children (depth-capped server-side; `THREAD_CHILDREN_PREVIEW` each). */
  children: ThreadNode[];
  /** The node has more direct replies than were embedded (`counts.replies`). */
  childrenTruncated: boolean;
}

/**
 * One node of a thread's reply tree (#152): a post plus a bounded slice of
 * its subtree. `z.lazy` recursion needs the explicit type annotation and an
 * `.openapi` name for the self-referencing $ref.
 */
export const threadNodeSchema: z.ZodType<ThreadNode> = z
  .lazy(() =>
    z
      .object({
        post: postSchema,
        children: z.array(threadNodeSchema),
        childrenTruncated: z.boolean(),
      })
      .strict(),
  )
  .openapi('ThreadNode');

export type ThreadNodeDto = z.infer<typeof threadNodeSchema>;

export const interactionKindSchema = z.enum(['like', 'bookmark', 'repost']);
export type InteractionKind = z.infer<typeof interactionKindSchema>;

export const interactionSchema = z.object({
  kind: interactionKindSchema,
  postId: postIdSchema,
  userId: userIdSchema,
  createdAt: z.iso.datetime(),
});

export type Interaction = z.infer<typeof interactionSchema>;

export const relationshipSchema = z.object({
  /** Viewer -> target */
  following: z.boolean(),
  /** Target follows viewer */
  followedBy: z.boolean(),
  /** Viewer has blocked target */
  blocking: z.boolean(),
  /** Target has blocked viewer */
  blockedBy: z.boolean(),
});

export type Relationship = z.infer<typeof relationshipSchema>;

export const feedEntryReasonSchema = z.enum(['post', 'repost']);
export type FeedEntryReason = z.infer<typeof feedEntryReasonSchema>;

/**
 * Valkey pub/sub channel that carries ws notifications for one user's feed
 * (spec 03). Any service may publish to it - the feed gateway is the only
 * subscriber (pattern `feed:updates:*`). Canonical here so publishers (feed
 * fan-out, posts interaction pings) cannot drift on the string.
 */
export const feedUpdatesChannel = (userId: string): string => `feed:updates:${userId}`;

/**
 * One materialised feed entry as the fanout worker submits it (internal bulk
 * upsert): ids + ordering columns only - post and author payloads are
 * hydrated on read (spec 03/04).
 */
export const feedEntryInputSchema = z.object({
  userId: userIdSchema,
  postId: postIdSchema,
  authorId: userIdSchema,
  reason: feedEntryReasonSchema,
  repostedById: userIdSchema.nullable().default(null),
  /** Post (or, for reposts, interaction) time - the feed ordering key. */
  postCreatedAt: z.iso.datetime(),
});

export type FeedEntryInput = z.infer<typeof feedEntryInputSchema>;

/**
 * Stable identity of the fanning-out source for one entry (#8 repost
 * natural key): a post entry is keyed by its post, a repost entry by
 * (post, reposter) - a post reposted by two users fans out to two distinct
 * entries per feed and must not collide. Derived, never stored raw in the
 * wire contract; feed computes/stores it verbatim. Centralised here so the
 * fanout worker and the feed service can never drift on the string format.
 */
export function feedEntryKey(input: {
  postId: string;
  reason: FeedEntryReason;
  repostedById?: string | null;
}): string {
  return input.reason === 'repost' && input.repostedById
    ? `repost:${input.postId}:${input.repostedById}`
    : `post:${input.postId}`;
}

export const feedItemSchema = z.object({
  postId: postIdSchema,
  authorId: userIdSchema,
  reason: feedEntryReasonSchema,
  repostedById: userIdSchema.nullable(),
  postCreatedAt: z.iso.datetime(),
});

export type FeedItem = z.infer<typeof feedItemSchema>;

/** Feed page item as served by `GET /v1/feed`: entry hydrated server-side. */
export const hydratedFeedItemSchema = z.object({
  post: postSchema,
  author: profileSchema,
  reason: feedEntryReasonSchema,
  /** Reposter profile for `reason: repost` entries (attribution); else null. */
  repostedBy: profileSchema.nullable(),
});

export type HydratedFeedItem = z.infer<typeof hydratedFeedItemSchema>;

/**
 * The caller's interaction flags for one post (batched viewer state): which
 * of like/repost/bookmark the viewer already has. Missing ids in the
 * response mean "no interactions" and default to false on clients.
 */
export const postViewerStateSchema = z.object({
  postId: postIdSchema,
  liked: z.boolean(),
  reposted: z.boolean(),
  bookmarked: z.boolean(),
});

export type PostViewerState = z.infer<typeof postViewerStateSchema>;

/** WS notification (spec 03): a hint to refetch, never a data channel. */
export const feedNewItemsMessageSchema = z.object({
  type: z.literal('feed.new-items'),
  count: z.number().int().nonnegative(),
});

export type FeedNewItemsMessage = z.infer<typeof feedNewItemsMessageSchema>;

export const pageMetaSchema = z.object({
  cursor: z.string().nullable(),
  limit: z.number().int().positive(),
});

export type PageMeta = z.infer<typeof pageMetaSchema>;
