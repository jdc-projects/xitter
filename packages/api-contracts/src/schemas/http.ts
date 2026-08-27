import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

import {
  POST_MEDIA_MAX,
  POST_TEXT_MAX,
  feedEntryInputSchema,
  hydratedFeedItemSchema,
  interactionKindSchema,
  internalMediaAssetSchema,
  mediaAltTextInputSchema,
  mediaAssetSchema,
  mediaIdSchema,
  mediaVariantCoreSchema,
  postIdSchema,
  postSchema,
  postViewerStateSchema,
  profileSchema,
  profileWithCountsSchema,
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
//
// Attachment entries (#133): a bare media id (the historical shape, still
// accepted) or an object carrying optional alt text for that asset.
const postMediaAttachmentSchema = z.union([
  mediaIdSchema,
  z
    .object({
      mediaId: mediaIdSchema,
      altText: mediaAltTextInputSchema.optional(),
    })
    .strict(),
]);

export const createPostRequestSchema = z
  .object({
    text: z.string().min(1).max(POST_TEXT_MAX),
    mediaIds: z.array(postMediaAttachmentSchema).max(POST_MEDIA_MAX).default([]),
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
// ownership and ready-status checks happen against this response. Optional
// altTexts (#133): author-supplied alt text persisted onto the owned assets
// (keys must be a subset of mediaIds - one asset, one text, no orphans).
export const mediaLookupRequestSchema = z
  .object({
    ownerId: userIdSchema,
    mediaIds: z.array(mediaIdSchema).min(1).max(POST_MEDIA_MAX),
    altTexts: z.record(mediaIdSchema, mediaAltTextInputSchema).optional(),
  })
  .strict()
  .refine(
    ({ mediaIds, altTexts }) =>
      !altTexts || Object.keys(altTexts).every((id) => mediaIds.includes(id)),
    { message: 'altTexts keys must be a subset of mediaIds' },
  );

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

// Shared cursor-page query params (feed/posts/search list endpoints): the
// services' controllers and OpenAPI registries parse the identical shape.
// Query params arrive as strings, hence the coercion.
export const pageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

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

// Internal (worker → owning service): report the last processed Kafka
// position so a worker restart (or a wiped consumer group) resumes exactly
// there - the durable resume cursor, not Kafka's group offsets (deleted by
// the nightly reset). One definition behind the per-service exports below
// (search-index → SearchCheckpoint, fanout → FeedCheckpoint) so the two
// stores cannot drift apart; the service-prefixed names keep each
// registry/controller import self-describing.
const checkpointPutRequestSchema = z
  .object({
    consumerKey: z.string().min(1).max(100),
    /** `topic:partition`, e.g. `xitter.posts.v1:0`. */
    topicPartition: z.string().min(1).max(100),
    offset: z.number().int().nonnegative(),
    eventId: z.string().min(1),
    eventAt: z.iso.datetime(),
  })
  .strict();

export type CheckpointPutRequest = z.infer<typeof checkpointPutRequestSchema>;

/** Search-index worker → search (SearchCheckpoint, spec 05). */
export const searchCheckpointPutRequestSchema = checkpointPutRequestSchema;
export type SearchCheckpointPutRequest = CheckpointPutRequest;

/** Fanout worker → feed (FeedCheckpoint, #149). */
export const feedCheckpointPutRequestSchema = checkpointPutRequestSchema;
export type FeedCheckpointPutRequest = CheckpointPutRequest;

const checkpointPositionSchema = z
  .object({
    topicPartition: z.string(),
    offset: z.number().int().nonnegative(),
    eventId: z.string().nullable(),
    eventAt: z.string().nullable(),
  })
  .strict();

export type CheckpointPosition = z.infer<typeof checkpointPositionSchema>;

export const searchCheckpointPositionSchema = checkpointPositionSchema;
export type SearchCheckpointPosition = CheckpointPosition;

export const feedCheckpointPositionSchema = checkpointPositionSchema;
export type FeedCheckpointPosition = CheckpointPosition;

const checkpointListResponseSchema = z
  .object({
    positions: z.array(checkpointPositionSchema),
  })
  .strict();

export const searchCheckpointListResponseSchema = checkpointListResponseSchema;
export type SearchCheckpointListResponse = z.infer<typeof searchCheckpointListResponseSchema>;

export const feedCheckpointListResponseSchema = checkpointListResponseSchema;
export type FeedCheckpointListResponse = z.infer<typeof feedCheckpointListResponseSchema>;

export const idParam = (name: 'userId' | 'postId' | 'mediaId' | 'username') =>
  ({
    userId: { name: 'userId', schema: userIdSchema, in: 'path', required: true },
    postId: { name: 'postId', schema: postIdSchema, in: 'path', required: true },
    mediaId: { name: 'mediaId', schema: mediaIdSchema, in: 'path', required: true },
    username: { name: 'username', schema: usernameSchema, in: 'path', required: true },
  })[name];

/**
 * Last reset run, surfaced by the feed service for the admin health tile
 * (spec 03 internal table; T13). Written by the reset job after every run -
 * success or failure - so operators always see the freshest outcome.
 */
export const resetStepStatusSchema = z
  .object({
    name: z.string(),
    ok: z.boolean(),
    durationMs: z.number().int().nonnegative(),
  })
  .strict()
  .openapi('ResetStepStatus');

export type ResetStepStatus = z.infer<typeof resetStepStatusSchema>;

export const resetStatusSchema = z
  .object({
    job: z.string(),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    durationMs: z.number().int().nonnegative(),
    success: z.boolean(),
    reseeded: z.boolean(),
    /** Seed corpus digest when reseeded, else null. */
    fingerprint: z.string().nullable(),
    steps: z.array(resetStepStatusSchema),
  })
  .strict()
  .openapi('ResetStatus');

export type ResetStatus = z.infer<typeof resetStatusSchema>; // ---------------------------------------------------------------------------
// Internal admin endpoints (admin-role-gated, spec 03 §admin). These live at
// /api/{service}/internal/admin/... and are called by the admin panel (an
// admin-realm user token) and machine tooling (the svc-admin service token).
// ---------------------------------------------------------------------------

export const ADMIN_LIMIT_MAX = 100;

// Shared cursor-pagination shape for the admin list queries (the page size
// ceiling is panel-scale by decree, spec 03 §admin).
const adminPageQuery = {
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(ADMIN_LIMIT_MAX).default(20),
};

/** Posts list filters for the moderation view. `deleted` absent = all. */
export const adminPostsListQuerySchema = z
  .object({
    authorId: userIdSchema.optional(),
    text: z.string().min(1).max(POST_TEXT_MAX).optional(),
    deleted: z.enum(['true', 'false']).optional(),
    ...adminPageQuery,
  })
  .strict();

export type AdminPostsListQuery = z.infer<typeof adminPostsListQuerySchema>;

export const adminPostPageSchema = cursorPagination(postSchema).openapi('AdminPostPage');

/** Moderation deletes may be soft (hide, restorable) or hard (row gone). */
export const adminDeletePostQuerySchema = z
  .object({
    hard: z.enum(['true', 'false']).default('false'),
  })
  .strict();

export type AdminDeletePostQuery = z.infer<typeof adminDeletePostQuerySchema>;

/** Media list filters for the moderation view. */
export const adminMediaListQuerySchema = z
  .object({
    ownerId: userIdSchema.optional(),
    status: z.enum(['pending', 'ready', 'failed']).optional(),
    ...adminPageQuery,
  })
  .strict();

export type AdminMediaListQuery = z.infer<typeof adminMediaListQuerySchema>;

export const adminMediaPageSchema =
  cursorPagination(internalMediaAssetSchema).openapi('AdminMediaPage');

/** Users list filters (social internal admin view). */
export const adminUsersListQuerySchema = z
  .object({
    username: usernameSchema.optional(),
    ...adminPageQuery,
  })
  .strict();

export type AdminUsersListQuery = z.infer<typeof adminUsersListQuerySchema>;

export const adminUserPageSchema =
  cursorPagination(profileWithCountsSchema).openapi('AdminUserPage');

/** Follow-graph view: the profile plus first pages of both edge directions. */
export const adminFollowGraphSchema = z
  .object({
    profile: profileWithCountsSchema,
    followers: z.array(profileSchema),
    following: z.array(profileSchema),
  })
  .strict()
  .openapi('AdminFollowGraph');

export type AdminFollowGraph = z.infer<typeof adminFollowGraphSchema>;

/** One audit entry: who did what to which object, when (posts/media DBs). */
export const adminAuditEntrySchema = z
  .object({
    id: z.uuid(),
    actorId: z.string().min(1),
    actorName: z.string().min(1),
    action: z.enum(['post.soft-delete', 'post.hard-delete', 'post.restore', 'media.delete']),
    targetId: z.string().min(1),
    detail: z.record(z.string(), z.unknown()).nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi('AdminAuditEntry');

export type AdminAuditEntry = z.infer<typeof adminAuditEntrySchema>;

export const adminAuditPageSchema =
  cursorPagination(adminAuditEntrySchema).openapi('AdminAuditPage');

/** Per-service health as the admin dashboard renders it (Terminus details). */
export const adminHealthSchema = z
  .object({
    service: z.string().min(1),
    status: z.enum(['ok', 'error']),
    uptimeSeconds: z.number().int().nonnegative(),
    version: z.string().min(1),
    checks: z.record(
      z.string(),
      z.object({ status: z.enum(['up', 'down']), message: z.string().optional() }),
    ),
  })
  .strict()
  .openapi('AdminHealth');

export type AdminHealth = z.infer<typeof adminHealthSchema>;
