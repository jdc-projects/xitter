import { OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  createInteractionRequestSchema,
  createPostRequestSchema,
  errorSchema,
  interactionSchema,
  postLookupRequestSchema,
  postLookupResponseSchema,
  postIdSchema,
  postSchema,
  userIdSchema,
  viewerStateResponseSchema,
} from '@xitter/api-contracts';

extendZodWithOpenApi(z);

const postParams = z.object({ postId: postIdSchema });
const userParams = z.object({ userId: userIdSchema });

const pageQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const postPage = z.object({
  items: z.array(postSchema),
  nextCursor: z.string().nullable(),
});

const jsonResponse = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});

export const postsApi = new OpenAPIRegistry();

postsApi.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

postsApi.registerComponent('securitySchemes', 'serviceToken', {
  type: 'http',
  scheme: 'bearer',
  description: 'Client-credentials service token (audience = svc-posts).',
});

postsApi.registerPath({
  method: 'post',
  path: '/posts',
  tags: ['posts'],
  security: [{ bearerAuth: [] }],
  description:
    'Create a post or reply. `text` is 1-512 chars; `mediaIds` (max 4) must exist, belong to the author and be ready (media internal lookup; non-ready ids 400 with details). Replies are rejected when a block exists between the replier and the parent author in either direction.',
  request: {
    body: { content: { 'application/json': { schema: createPostRequestSchema } } },
  },
  responses: {
    201: jsonResponse('Created post', postSchema),
    400: jsonResponse('Validation error', errorSchema),
    403: jsonResponse('Blocked from replying', errorSchema),
    404: jsonResponse('Reply target not found', errorSchema),
  },
});

postsApi.registerPath({
  method: 'delete',
  path: '/posts/{postId}',
  tags: ['posts'],
  security: [{ bearerAuth: [] }],
  description: 'Soft-delete own post (author only). Deleted posts are hidden everywhere.',
  request: { params: postParams },
  responses: {
    204: { description: 'Deleted' },
    403: jsonResponse('Not the author', errorSchema),
    404: jsonResponse('Not found', errorSchema),
  },
});

postsApi.registerPath({
  method: 'get',
  path: '/posts/{postId}',
  tags: ['posts'],
  security: [{ bearerAuth: [] }],
  request: { params: postParams },
  responses: {
    200: jsonResponse('Post', postSchema),
    404: jsonResponse('Not found (or deleted)', errorSchema),
  },
});

postsApi.registerPath({
  method: 'get',
  path: '/users/{userId}/posts',
  tags: ['posts'],
  security: [{ bearerAuth: [] }],
  description: "Author's visible posts, newest first (replies included).",
  request: { params: userParams, query: pageQuery },
  responses: {
    200: jsonResponse('Post page', postPage),
  },
});

postsApi.registerPath({
  method: 'get',
  path: '/posts/{postId}/replies',
  tags: ['posts'],
  security: [{ bearerAuth: [] }],
  description: 'Replies to a post in chronological (oldest first) order.',
  request: { params: postParams, query: pageQuery },
  responses: {
    200: jsonResponse('Replies page', postPage),
    404: jsonResponse('Parent not found (or deleted)', errorSchema),
  },
});

postsApi.registerPath({
  method: 'post',
  path: '/posts/{postId}/interactions',
  tags: ['interactions'],
  security: [{ bearerAuth: [] }],
  description:
    'Like, bookmark or repost a post. Idempotent on (kind, postId, userId). Rejected 403 when the caller is blocked by the post author (either direction). Reposting a repost reposts the original post - reposts are interactions, not posts, so chains cannot form; reposting your own post is allowed. Likes/reposts bump the post counts read-model and (for others\u2019 posts) ping the author over the feed ws channel without creating feed entries.',
  request: {
    params: postParams,
    body: { content: { 'application/json': { schema: createInteractionRequestSchema } } },
  },
  responses: {
    201: jsonResponse('Interaction (existing row on idempotent repeat)', interactionSchema),
    400: jsonResponse('Validation error', errorSchema),
    403: jsonResponse('Blocked from interacting', errorSchema),
    404: jsonResponse('Post not found (or deleted)', errorSchema),
  },
});

postsApi.registerPath({
  method: 'delete',
  path: '/posts/{postId}/interactions/{kind}',
  tags: ['interactions'],
  security: [{ bearerAuth: [] }],
  description:
    'Remove the caller\u2019s own interaction (idempotent 204). An undone repost removes its feed entries everywhere.',
  request: {
    params: z.object({ postId: postIdSchema, kind: z.enum(['like', 'bookmark', 'repost']) }),
  },
  responses: {
    204: { description: 'Removed (or nothing to remove)' },
    400: jsonResponse('Validation error', errorSchema),
    404: jsonResponse('Post not found', errorSchema),
  },
});

postsApi.registerPath({
  method: 'get',
  path: '/bookmarks',
  tags: ['interactions'],
  security: [{ bearerAuth: [] }],
  description:
    "The caller's bookmarked posts, newest bookmark first. Private: only the caller's own bookmarks are ever listed. Soft-deleted posts drop out.",
  request: { query: pageQuery },
  responses: {
    200: jsonResponse('Bookmarks page', postPage),
  },
});

postsApi.registerPath({
  method: 'get',
  path: '/viewer-state',
  tags: ['interactions'],
  security: [{ bearerAuth: [] }],
  description:
    "Batched viewer flags for list rendering: the caller's like/repost/bookmark state per post. `postIds` is a single comma-separated query param (1-100 uuids); ids with no interaction are returned with all flags false.",
  request: {
    query: z.object({
      postIds: z.string().min(1).openapi({ example: 'uuid,uuid' }),
    }),
  },
  responses: {
    200: jsonResponse('Viewer flags per post', viewerStateResponseSchema),
    400: jsonResponse('Validation error (bad or over-cap postIds)', errorSchema),
  },
});

// Internal endpoints: no version segment, service tokens only (spec 03).
postsApi.registerPath({
  method: 'post',
  path: '/internal/posts/lookup',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description:
    'Bulk visible-post lookup (feed #7 hydration); deleted/missing ids are omitted from the response.',
  request: { body: { content: { 'application/json': { schema: postLookupRequestSchema } } } },
  responses: {
    200: jsonResponse('Visible posts', postLookupResponseSchema),
  },
});

postsApi.registerPath({
  method: 'post',
  path: '/internal/reseed',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description:
    'Truncate posts + interactions (reset job); deterministic reseed runs via the seed script.',
  responses: { 200: jsonResponse('Acknowledged', z.object({ ok: z.boolean() })) },
});
