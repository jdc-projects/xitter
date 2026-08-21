import { OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  errorSchema,
  hydratedFeedItemSchema,
  postIdSchema,
  resetStatusSchema,
  upsertFeedEntriesRequestSchema,
  upsertFeedEntriesResponseSchema,
  userIdSchema,
} from '@xitter/api-contracts';

extendZodWithOpenApi(z);

const feedPage = z.object({
  items: z.array(hydratedFeedItemSchema),
  nextCursor: z.string().nullable(),
});

const userParams = z.object({ userId: userIdSchema });
const postParams = z.object({ postId: postIdSchema });
const authorParams = z.object({ userId: userIdSchema, authorId: userIdSchema });

const jsonResponse = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});

const pageQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const feedApi = new OpenAPIRegistry();

feedApi.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

feedApi.registerComponent('securitySchemes', 'serviceToken', {
  type: 'http',
  scheme: 'bearer',
  description: 'Client-credentials service token (audience = svc-feed).',
});

feedApi.registerPath({
  method: 'get',
  path: '/feed',
  tags: ['feed'],
  security: [{ bearerAuth: [] }],
  description:
    'Materialised home timeline (followed + own posts and reposts, newest first), hydrated server-side; deleted posts and blocked authors are excluded. Repost entries carry the reposter profile (`repostedBy`) for attribution.',
  request: { query: pageQuery },
  responses: {
    200: { description: 'Feed page', content: { 'application/json': { schema: feedPage } } },
    400: jsonResponse('Invalid cursor', errorSchema),
  },
});

feedApi.registerPath({
  method: 'get',
  path: '/ws',
  tags: ['feed'],
  description:
    'WebSocket endpoint (wss upgrade only): `wss://{host}/api/feed/v1/ws?token={accessToken}`. Server-to-client notifications only - `{ "type": "feed.new-items", "count": n }`; clients refetch `GET /v1/feed`.',
  responses: {
    400: jsonResponse('Plain HTTP GET: connect via wss upgrade instead', errorSchema),
  },
});

// Internal endpoints: no version segment, service tokens only (spec 03).
feedApi.registerPath({
  method: 'post',
  path: '/internal/feed/entries',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description:
    'Bulk idempotent entry upsert (fanout worker); conflicts on the natural key (userId, entryKey - derived per source: `post:{postId}` / `repost:{postId}:{repostedById}`) are skipped. Affected users get a ws notification.',
  request: {
    body: { content: { 'application/json': { schema: upsertFeedEntriesRequestSchema } } },
  },
  responses: {
    200: jsonResponse('Rows actually inserted (replays report 0)', upsertFeedEntriesResponseSchema),
    400: jsonResponse('Validation error', errorSchema),
  },
});

feedApi.registerPath({
  method: 'delete',
  path: '/internal/feed/posts/{postId}/entries',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description: 'Post deleted: entries for the post leave every feed (fanout worker).',
  request: { params: postParams },
  responses: { 200: jsonResponse('Rows deleted', z.object({ deleted: z.number().int() })) },
});

feedApi.registerPath({
  method: 'delete',
  path: '/internal/feed/posts/{postId}/reposts/{repostedById}',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description:
    'Repost undone (#8): only that reposter\u2019s repost entries for the post go - the post\u2019s own entries and other reposters\u2019 stay.',
  request: { params: z.object({ postId: postIdSchema, repostedById: userIdSchema }) },
  responses: { 200: jsonResponse('Rows deleted', z.object({ deleted: z.number().int() })) },
});

feedApi.registerPath({
  method: 'delete',
  path: '/internal/feed/users/{userId}/authors/{authorId}',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description: 'Unfollowed: the author entries leave this one feed (fanout worker).',
  request: { params: authorParams },
  responses: { 200: jsonResponse('Rows deleted', z.object({ deleted: z.number().int() })) },
});

feedApi.registerPath({
  method: 'delete',
  path: '/internal/feed/users/{userId}',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description: 'Delete all feed entries for a user (reset job / fanout).',
  request: { params: userParams },
  responses: { 200: jsonResponse('Rows deleted', z.object({ deleted: z.number().int() })) },
});

feedApi.registerPath({
  method: 'post',
  path: '/internal/reseed',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description: 'Truncate feed entries (reset job); the timeline rebuilds from events.',
  responses: { 200: jsonResponse('Acknowledged', z.object({ ok: z.boolean() })) },
});

feedApi.registerPath({
  method: 'get',
  path: '/internal/reset-status',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description:
    'Last reset/reseed run (written by the reset job to Valkey) for the admin health tile; null when no reset has run.',
  responses: {
    200: jsonResponse('Reset status or null', resetStatusSchema.nullable()),
  },
});
