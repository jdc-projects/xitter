import { OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  createPostRequestSchema,
  errorSchema,
  postIdSchema,
  postSchema,
  userIdSchema,
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
    'Create a post or reply. `text` is 1-512 chars; `mediaIds` are shape-checked UUIDs (max 4) - existence/status checks land with the media ticket (#6). Replies are rejected when a block exists between the replier and the parent author in either direction.',
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

// Internal endpoints: no version segment, service tokens only (spec 03).
postsApi.registerPath({
  method: 'post',
  path: '/internal/reseed',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description:
    'Truncate posts + interactions (reset job); deterministic reseed runs via the seed script.',
  responses: { 200: jsonResponse('Acknowledged', z.object({ ok: z.boolean() })) },
});
