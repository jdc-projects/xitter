import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

import {
  POST_MEDIA_MAX,
  POST_TEXT_MAX,
  interactionKindSchema,
  mediaIdSchema,
  postIdSchema,
  postSchema,
  profileSchema,
  userIdSchema,
  usernameSchema,
} from './domain.js';

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
  .openapi('Error');

// strict: unknown keys must 400, not silently strip (mediaIds are validated
// for shape only - uuid, max 4 - until #6 adds existence/status checks).
export const createPostRequestSchema = z
  .object({
    text: z.string().min(1).max(POST_TEXT_MAX),
    mediaIds: z.array(mediaIdSchema).max(POST_MEDIA_MAX).default([]),
    replyToId: postIdSchema.nullable().default(null),
  })
  .strict()
  .openapi('CreatePostRequest');

export type CreatePostRequest = z.infer<typeof createPostRequestSchema>;

const profileFields = {
  displayName: z.string().min(1).max(50).optional(),
  bio: z.string().max(200).nullable().optional(),
};

// strict: username is immutable - sending it must 4xx, not silently strip.
export const updateProfileRequestSchema = z
  .object(profileFields)
  .strict()
  .openapi('UpdateProfileRequest');

export const createProfileRequestSchema = z
  .object({
    ...profileFields,
  })
  .strict()
  .openapi('CreateProfileRequest');

export type CreateProfileRequest = z.infer<typeof createProfileRequestSchema>;
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

export const createInteractionRequestSchema = z
  .object({
    kind: interactionKindSchema,
  })
  .openapi('CreateInteractionRequest');

export const createMediaUploadRequestSchema = z
  .object({
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    bytes: z.number().int().positive(),
  })
  .openapi('CreateMediaUploadRequest');

export const postPageSchema = cursorPagination(postSchema).openapi('PostPage');

export const profilePageSchema = cursorPagination(profileSchema).openapi('ProfilePage');

export const feedPageSchema = cursorPagination(z.unknown()).openapi('FeedPage');

export const idParam = (name: 'userId' | 'postId' | 'mediaId' | 'username') =>
  ({
    userId: { name: 'userId', schema: userIdSchema, in: 'path', required: true },
    postId: { name: 'postId', schema: postIdSchema, in: 'path', required: true },
    mediaId: { name: 'mediaId', schema: mediaIdSchema, in: 'path', required: true },
    username: { name: 'username', schema: usernameSchema, in: 'path', required: true },
  })[name];
