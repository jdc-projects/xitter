import { z } from "zod";
import { interactionKindSchema, mediaIdSchema, postIdSchema, userIdSchema } from "./domain.js";

/**
 * Event payload schemas. Each becomes one member of the discriminated union in
 * @xitter/events; `eventType` values are defined there.
 */

export const postCreated = z.object({
  eventType: z.literal("posts.post.created"),
  postId: postIdSchema,
  authorId: userIdSchema,
  text: z.string().min(1),
  mediaIds: z.array(mediaIdSchema),
  replyToId: postIdSchema.nullable(),
  repostOfId: postIdSchema.nullable(),
  createdAt: z.iso.datetime(),
});

export const postDeleted = z.object({
  eventType: z.literal("posts.post.deleted"),
  postId: postIdSchema,
  authorId: userIdSchema,
  deletedAt: z.iso.datetime(),
});

export const interactionCreated = z.object({
  eventType: z.literal("posts.interaction.created"),
  kind: interactionKindSchema,
  postId: postIdSchema,
  userId: userIdSchema,
  createdAt: z.iso.datetime(),
});

export const interactionDeleted = z.object({
  eventType: z.literal("posts.interaction.deleted"),
  kind: interactionKindSchema,
  postId: postIdSchema,
  userId: userIdSchema,
  deletedAt: z.iso.datetime(),
});

export const followCreated = z.object({
  eventType: z.literal("social.follow.created"),
  followerId: userIdSchema,
  followeeId: userIdSchema,
  createdAt: z.iso.datetime(),
});

export const followDeleted = z.object({
  eventType: z.literal("social.follow.deleted"),
  followerId: userIdSchema,
  followeeId: userIdSchema,
  deletedAt: z.iso.datetime(),
});

export const blockCreated = z.object({
  eventType: z.literal("social.block.created"),
  blockerId: userIdSchema,
  blockedId: userIdSchema,
  createdAt: z.iso.datetime(),
});

export const blockDeleted = z.object({
  eventType: z.literal("social.block.deleted"),
  blockerId: userIdSchema,
  blockedId: userIdSchema,
  deletedAt: z.iso.datetime(),
});

export const mediaUploaded = z.object({
  eventType: z.literal("media.media.uploaded"),
  mediaId: mediaIdSchema,
  ownerId: userIdSchema,
  objectKey: z.string().min(1),
  mimeType: z.string().min(1),
  bytes: z.number().int().positive(),
  createdAt: z.iso.datetime(),
});

export const mediaProcessed = z.object({
  eventType: z.literal("media.media.processed"),
  mediaId: mediaIdSchema,
  ownerId: userIdSchema,
  variants: z.array(
    z.object({
      kind: z.enum(["original", "thumb"]),
      objectKey: z.string().min(1),
      mimeType: z.string().min(1),
      bytes: z.number().int().positive(),
      width: z.number().int().positive().nullable(),
      height: z.number().int().positive().nullable(),
    }),
  ),
  processedAt: z.iso.datetime(),
});

export type PostCreated = z.infer<typeof postCreated>;
export type PostDeleted = z.infer<typeof postDeleted>;
export type InteractionCreated = z.infer<typeof interactionCreated>;
export type InteractionDeleted = z.infer<typeof interactionDeleted>;
export type FollowCreated = z.infer<typeof followCreated>;
export type FollowDeleted = z.infer<typeof followDeleted>;
export type BlockCreated = z.infer<typeof blockCreated>;
export type BlockDeleted = z.infer<typeof blockDeleted>;
export type MediaUploaded = z.infer<typeof mediaUploaded>;
export type MediaProcessed = z.infer<typeof mediaProcessed>;
