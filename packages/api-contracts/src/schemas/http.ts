import { z } from "zod";
import {
  POST_MEDIA_MAX,
  POST_TEXT_MAX,
  interactionKindSchema,
  mediaIdSchema,
  postIdSchema,
  userIdSchema,
  usernameSchema,
} from "./domain.js";

const cursorPagination = (itemSchema: z.ZodType) =>
  z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable(),
  });

export const errorSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  })
  .openapi({ ref: "Error" });

export const createPostRequestSchema = z
  .object({
    text: z.string().min(1).max(POST_TEXT_MAX),
    mediaIds: z.array(mediaIdSchema).max(POST_MEDIA_MAX).default([]),
    replyToId: postIdSchema.nullable().default(null),
  })
  .openapi({ ref: "CreatePostRequest" });

export const updateProfileRequestSchema = z
  .object({
    displayName: z.string().min(1).max(50).optional(),
    bio: z.string().max(200).nullable().optional(),
  })
  .openapi({ ref: "UpdateProfileRequest" });

export const createInteractionRequestSchema = z
  .object({
    kind: interactionKindSchema,
  })
  .openapi({ ref: "CreateInteractionRequest" });

export const createMediaUploadRequestSchema = z
  .object({
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    bytes: z.number().int().positive(),
  })
  .openapi({ ref: "CreateMediaUploadRequest" });

export const postPageSchema = cursorPagination(
  z.object({ post: z.unknown(), author: z.unknown() }),
).openapi({ ref: "PostPage" });

export const profilePageSchema = cursorPagination(z.unknown()).openapi({ ref: "ProfilePage" });

export const feedPageSchema = cursorPagination(z.unknown()).openapi({ ref: "FeedPage" });

export const idParam = (name: "userId" | "postId" | "mediaId" | "username") =>
  ({
    userId: { name: "userId", schema: userIdSchema, in: "path", required: true },
    postId: { name: "postId", schema: postIdSchema, in: "path", required: true },
    mediaId: { name: "mediaId", schema: mediaIdSchema, in: "path", required: true },
    username: { name: "username", schema: usernameSchema, in: "path", required: true },
  })[name];
