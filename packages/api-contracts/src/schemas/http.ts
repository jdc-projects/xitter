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
  postViewerStateSchema,
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
  .strict()
  .openapi('CreateInteractionRequest');

export type CreateInteractionRequest = z.infer<typeof createInteractionRequestSchema>;

// Batched viewer state for lists (`GET /v1/posts/viewer-state`): postIds ride
// the query string as a single comma-separated list (URL-friendly; max 100).
export const viewerStateQuerySchema = z
  .object({
    postIds: z
      .string()
      .min(1)
      .transform((raw, ctx) => {
        const ids = raw
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean);
        const parsed = z.array(postIdSchema).max(100).safeParse(ids);
        if (!parsed.success) {
          ctx.addIssue({ code: 'custom', message: 'postIds must be 1-100 comma-separated uuids' });
          return z.NEVER;
        }
        return parsed.data;
      }),
  })
  .openapi('ViewerStateQuery');

export const viewerStateResponseSchema = z
  .object({
    items: z.array(postViewerStateSchema),
  })
  .strict()
  .openapi('ViewerStateResponse');

export type ViewerStateResponse = z.infer<typeof viewerStateResponseSchema>;

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

// Internal (fanout worker → feed): bulk idempotent upsert of feed entries.
// Idempotency is the feed-owned dedupe key derived per entry (`post:{postId}`
// or `repost:{postId}:{repostedById}`) - repostedById itself cannot join a
// unique index directly (Postgres treats NULLs as distinct, and it is NULL
// for reason='post' rows); spec 04.
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

export type PostLookupRequest = z.infer<typeof postLookupRequestSchema>;
export type PostLookupResponse = z.infer<typeof postLookupResponseSchema>;

// Internal (fanout worker → posts): the followee's recent posts for the
// follow backfill (spec 04). Same page shape as the public author timeline.
export const internalAuthorPostsRequestSchema = z
  .object({
    authorId: userIdSchema,
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

export type InternalAuthorPostsRequest = z.infer<typeof internalAuthorPostsRequestSchema>;

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

export type ProfileLookupRequest = z.infer<typeof profileLookupRequestSchema>;
export type ProfileLookupResponse = z.infer<typeof profileLookupResponseSchema>;

export const postPageSchema = cursorPagination(postSchema).openapi('PostPage');

export const profilePageSchema = cursorPagination(profileSchema).openapi('ProfilePage');

export const feedPageSchema = cursorPagination(hydratedFeedItemSchema).openapi('FeedPage');

/** Search results carry the same hydrated shape as feed items (spec 03). */
export const searchPageSchema = cursorPagination(hydratedFeedItemSchema).openapi('SearchPage');

export type SearchPage = z.infer<typeof searchPageSchema>;

// Internal (search-index worker → search): one post document in the
// OpenSearch `posts` index. `deletedAt` set = tombstone (spec 04: deletes
// are tombstones; upserts are keyed by postId, so replays converge).
// `text` has no minimum: tombstones written from posts.post.deleted carry
// no body (empty placeholder, never matched - queries exclude deletedAt).
export const searchIndexDocumentSchema = z
  .object({
    postId: postIdSchema,
    authorId: userIdSchema,
    authorName: z.string().min(1).max(50),
    text: z.string().max(POST_TEXT_MAX),
    keywords: z.array(z.string().min(1).max(100)).max(32).default([]),
    createdAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().nullable().default(null),
  })
  .strict()
  .openapi('SearchIndexDocument');

export type SearchIndexDocument = z.infer<typeof searchIndexDocumentSchema>;

export const upsertSearchDocumentsRequestSchema = z
  .object({
    documents: z.array(searchIndexDocumentSchema).min(1).max(1000),
  })
  .strict()
  .openapi('UpsertSearchDocumentsRequest');

export type UpsertSearchDocumentsRequest = z.infer<typeof upsertSearchDocumentsRequestSchema>;

export const upsertSearchDocumentsResponseSchema = z
  .object({
    /** Documents actually submitted to the index bulk request. */
    indexed: z.number().int().nonnegative(),
  })
  .strict();

// Internal (search-index worker → search): refresh the denormalised
// authorName on every indexed document of the listed authors
// (social.profile.updated keeps the index self-contained).
export const refreshSearchAuthorsRequestSchema = z
  .object({
    authors: z
      .array(
        z
          .object({
            authorId: userIdSchema,
            authorName: z.string().min(1).max(50),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .openapi('RefreshSearchAuthorsRequest');

export type RefreshSearchAuthorsRequest = z.infer<typeof refreshSearchAuthorsRequestSchema>;

// Internal (search-index worker → search): report the last processed Kafka
// position so a worker restart (or a wiped consumer group) resumes exactly
// there - SearchCheckpoint is the durable resume cursor, not Kafka's group
// offsets (deleted by the nightly reset).
export const searchCheckpointPutRequestSchema = z
  .object({
    consumerKey: z.string().min(1).max(100),
    /** `topic:partition`, e.g. `xitter.posts.v1:0`. */
    topicPartition: z.string().min(1).max(100),
    offset: z.number().int().nonnegative(),
    eventId: z.string().min(1),
    eventAt: z.iso.datetime(),
  })
  .strict();

export type SearchCheckpointPutRequest = z.infer<typeof searchCheckpointPutRequestSchema>;

export const searchCheckpointPositionSchema = z
  .object({
    topicPartition: z.string(),
    offset: z.number().int().nonnegative(),
    eventId: z.string().nullable(),
    eventAt: z.string().nullable(),
  })
  .strict();

export const searchCheckpointListResponseSchema = z
  .object({
    positions: z.array(searchCheckpointPositionSchema),
  })
  .strict();

export type SearchCheckpointPosition = z.infer<typeof searchCheckpointPositionSchema>;

export const idParam = (name: 'userId' | 'postId' | 'mediaId' | 'username') =>
  ({
    userId: { name: 'userId', schema: userIdSchema, in: 'path', required: true },
    postId: { name: 'postId', schema: postIdSchema, in: 'path', required: true },
    mediaId: { name: 'mediaId', schema: mediaIdSchema, in: 'path', required: true },
    username: { name: 'username', schema: usernameSchema, in: 'path', required: true },
  })[name];
