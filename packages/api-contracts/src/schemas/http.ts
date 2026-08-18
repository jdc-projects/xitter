import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

import {
  POST_MEDIA_MAX,
  POST_TEXT_MAX,
  feedEntryInputSchema,
  hydratedFeedItemSchema,
  interactionKindSchema,
  mediaAssetSchema,
  mediaIdSchema,
  mediaVariantCoreSchema,
  postIdSchema,
  postSchema,
  profileSchema,
  userIdSchema,
  usernameSchema,
} from './domain.js';

const cursorPagination = <T>(itemSchema: z.ZodType<T>) =>
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

// Shape-only: the mime allowlist (415) and 5MB cap (413) are enforced by the
// media service with their spec-03 codes, not folded into the 400s this pipe
// produces.
export const createMediaUploadRequestSchema = z
  .object({
    mimeType: z.string().min(1),
    bytes: z.number().int().positive(),
  })
  .strict()
  .openapi('CreateMediaUploadRequest');

export type CreateMediaUploadRequest = z.infer<typeof createMediaUploadRequestSchema>;

export const createMediaUploadResponseSchema = z
  .object({
    mediaId: mediaIdSchema,
    uploadUrl: z.string().url(),
  })
  .openapi('CreateMediaUploadResponse');

export type CreateMediaUploadResponse = z.infer<typeof createMediaUploadResponseSchema>;

// Internal (media-process worker → media): record processed variants.
export const recordVariantsRequestSchema = z
  .object({
    variants: z.array(mediaVariantCoreSchema),
  })
  .strict()
  .openapi('RecordVariantsRequest');

export type RecordVariantsRequest = z.infer<typeof recordVariantsRequestSchema>;

// Internal (media-process worker → media): report a processing failure; the
// service owns the attempt counter and the failed transition.
export const reportMediaFailureRequestSchema = z
  .object({
    error: z.string().min(1),
  })
  .strict();

// Internal (posts → media): resolve assets for post attachment - existence,
// ownership and ready-status checks happen against this response.
export const mediaLookupRequestSchema = z
  .object({
    ownerId: userIdSchema,
    mediaIds: z.array(mediaIdSchema).min(1).max(POST_MEDIA_MAX),
  })
  .strict();

export const mediaLookupResponseSchema = z
  .object({
    items: z.array(mediaAssetSchema),
  })
  .strict();

// Internal (fanout worker → feed): bulk idempotent upsert of feed entries
// (natural key (userId, postId, reason, repostedById), spec 04).
export const upsertFeedEntriesRequestSchema = z
  .object({
    entries: z.array(feedEntryInputSchema).min(1).max(1000),
  })
  .strict()
  .openapi('UpsertFeedEntriesRequest');

export type UpsertFeedEntriesRequest = z.infer<typeof upsertFeedEntriesRequestSchema>;

export const upsertFeedEntriesResponseSchema = z
  .object({
    /** Rows actually inserted (replays conflict-skip; spec 04 idempotency). */
    inserted: z.number().int().nonnegative(),
  })
  .strict();

// Internal (feed → posts): bulk fetch of visible posts for hydration.
// Deleted/missing ids are omitted from the response.
export const postLookupRequestSchema = z
  .object({
    postIds: z.array(postIdSchema).min(1).max(100),
  })
  .strict();

export const postLookupResponseSchema = z
  .object({
    items: z.array(postSchema),
  })
  .strict();

// Internal (feed → social): bulk profile lookup for hydration. Missing ids
// are omitted; callers substitute placeholders.
export const profileLookupRequestSchema = z
  .object({
    userIds: z.array(userIdSchema).min(1).max(100),
  })
  .strict();

export const profileLookupResponseSchema = z
  .object({
    items: z.array(profileSchema),
  })
  .strict();

export const postPageSchema = cursorPagination(postSchema).openapi('PostPage');

export const profilePageSchema = cursorPagination(profileSchema).openapi('ProfilePage');

export const feedPageSchema = cursorPagination(hydratedFeedItemSchema).openapi('FeedPage');

export const idParam = (name: 'userId' | 'postId' | 'mediaId' | 'username') =>
  ({
    userId: { name: 'userId', schema: userIdSchema, in: 'path', required: true },
    postId: { name: 'postId', schema: postIdSchema, in: 'path', required: true },
    mediaId: { name: 'mediaId', schema: mediaIdSchema, in: 'path', required: true },
    username: { name: 'username', schema: usernameSchema, in: 'path', required: true },
  })[name];
