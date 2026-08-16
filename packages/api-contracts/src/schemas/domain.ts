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

export const mediaVariantSchema = z.object({
  kind: z.enum(['original', 'thumb']),
  objectKey: z.string().min(1),
  mimeType: z.string().min(1),
  bytes: z.number().int().positive(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});

export const mediaAssetSchema = z.object({
  id: mediaIdSchema,
  ownerId: userIdSchema,
  status: z.enum(['pending', 'ready', 'failed']),
  variants: z.array(mediaVariantSchema),
  createdAt: z.iso.datetime(),
});

export type MediaAsset = z.infer<typeof mediaAssetSchema>;

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

export const feedItemSchema = z.object({
  postId: postIdSchema,
  authorId: userIdSchema,
  reason: z.enum(['post', 'repost']),
  repostedById: userIdSchema.nullable(),
  postCreatedAt: z.iso.datetime(),
});

export type FeedItem = z.infer<typeof feedItemSchema>;

export const pageMetaSchema = z.object({
  cursor: z.string().nullable(),
  limit: z.number().int().positive(),
});

export type PageMeta = z.infer<typeof pageMetaSchema>;
