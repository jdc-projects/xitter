import { OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  errorSchema,
  refreshSearchAuthorsRequestSchema,
  searchCheckpointListResponseSchema,
  searchCheckpointPutRequestSchema,
  searchPageSchema,
  upsertSearchDocumentsRequestSchema,
} from '@xitter/api-contracts';

extendZodWithOpenApi(z);

const jsonResponse = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});

const searchQuery = z.object({
  q: z.string().min(1).max(512),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const searchApi = new OpenAPIRegistry();

searchApi.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

searchApi.registerComponent('securitySchemes', 'serviceToken', {
  type: 'http',
  scheme: 'bearer',
  description: 'Client-credentials service token (audience = svc-search).',
});

searchApi.registerPath({
  method: 'get',
  path: '/v1/posts',
  tags: ['search'],
  security: [{ bearerAuth: [] }],
  description:
    'Full-text post search (analysed text + exact keyword terms), relevance-ranked within a (createdAt, postId) keyset pagination. Results are hydrated server-side; tombstoned and blocked-author posts are excluded.',
  request: { query: searchQuery },
  responses: {
    200: jsonResponse('Search results page', searchPageSchema),
    400: jsonResponse('Invalid q/cursor/limit', errorSchema),
  },
});

// Internal endpoints: no version segment, service tokens only (spec 03).
searchApi.registerPath({
  method: 'post',
  path: '/internal/search/index',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description:
    'Bulk idempotent index upsert keyed by postId (search-index worker); documents with deletedAt set are tombstones that stop matching queries.',
  request: {
    body: { content: { 'application/json': { schema: upsertSearchDocumentsRequestSchema } } },
  },
  responses: {
    200: jsonResponse('Documents submitted to the index bulk request', z.object({ indexed: z.number().int() })),
    400: jsonResponse('Validation error', errorSchema),
  },
});

searchApi.registerPath({
  method: 'post',
  path: '/internal/search/index/authors',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description:
    'Refresh the denormalised authorName on an author's documents (social.profile.updated keeps the index self-contained).',
  request: {
    body: { content: { 'application/json': { schema: refreshSearchAuthorsRequestSchema } } },
  },
  responses: {
    200: jsonResponse('Documents updated', z.object({ updated: z.number().int() })),
    400: jsonResponse('Validation error', errorSchema),
  },
});

searchApi.registerPath({
  method: 'delete',
  path: '/internal/search/index',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description: 'Clear every indexed document (reset job); the mapping survives for reuse.',
  responses: { 200: jsonResponse('Documents deleted', z.object({ deleted: z.number().int() })) },
});

searchApi.registerPath({
  method: 'post',
  path: '/internal/search/checkpoint',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description:
    'Persist the worker's last processed Kafka position (durable resume cursor - consumer groups die with the nightly reset).',
  request: {
    body: { content: { 'application/json': { schema: searchCheckpointPutRequestSchema } } },
  },
  responses: { 204: { description: 'Stored' } },
});

searchApi.registerPath({
  method: 'get',
  path: '/internal/search/checkpoint',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description: 'Resume positions for one consumer (worker boot).',
  request: { query: z.object({ consumerKey: z.string().min(1).max(100) }) },
  responses: {
    200: jsonResponse('Positions by topic-partition', searchCheckpointListResponseSchema),
  },
});

searchApi.registerPath({
  method: 'post',
  path: '/internal/reseed',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description: 'Truncate search service state - checkpoints (reset job); index docs are cleared separately.',
  responses: { 200: jsonResponse('Acknowledged', z.object({ ok: z.boolean(), deleted: z.number().int() })) },
});
