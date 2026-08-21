import { OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  adminFollowGraphSchema,
  adminUserPageSchema,
  adminUsersListQuerySchema,
  createProfileRequestSchema,
  errorSchema,
  profileLookupRequestSchema,
  profileLookupResponseSchema,
  profilePageSchema,
  profileSchema,
  profileWithCountsSchema,
  relationshipSchema,
  updateProfileRequestSchema,
  userIdSchema,
  usernameSchema,
} from '@xitter/api-contracts';

extendZodWithOpenApi(z);

const idParams = z.object({ userId: userIdSchema });

const pageQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const jsonResponse = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});

export const socialApi = new OpenAPIRegistry();

socialApi.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

socialApi.registerComponent('securitySchemes', 'adminToken', {
  type: 'http',
  scheme: 'bearer',
  description:
    'Admin principal: an admin-realm user token (admin-panel client, ADMIN_ROLES realm role) or a svc-admin service token carrying an admin role.',
});

socialApi.registerComponent('securitySchemes', 'serviceToken', {
  type: 'http',
  scheme: 'bearer',
  description: 'Client-credentials service token (audience = svc-social).',
});

socialApi.registerPath({
  method: 'post',
  path: '/profiles/{userId}',
  tags: ['profiles'],
  security: [{ bearerAuth: [] }],
  description: 'Idempotent upsert of the caller own profile (`userId` = caller).',
  request: {
    params: idParams,
    body: { content: { 'application/json': { schema: createProfileRequestSchema } } },
  },
  responses: {
    200: jsonResponse('Profile (existing returned unchanged on re-POST)', profileSchema),
    400: jsonResponse('Validation error', errorSchema),
    403: jsonResponse('userId is not the caller', errorSchema),
  },
});

socialApi.registerPath({
  method: 'get',
  path: '/profiles/{userId}',
  tags: ['profiles'],
  security: [{ bearerAuth: [] }],
  request: { params: idParams },
  responses: {
    200: jsonResponse('Profile with follow counts', profileWithCountsSchema),
    404: jsonResponse('Not found', errorSchema),
  },
});

socialApi.registerPath({
  method: 'get',
  path: '/profiles/username/{username}',
  tags: ['profiles'],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ username: usernameSchema }) },
  responses: {
    200: jsonResponse('Profile', profileSchema),
    404: jsonResponse('Not found', errorSchema),
  },
});

socialApi.registerPath({
  method: 'patch',
  path: '/profiles/{userId}',
  tags: ['profiles'],
  security: [{ bearerAuth: [] }],
  description: 'Partial update, own profile only.',
  request: {
    params: idParams,
    body: { content: { 'application/json': { schema: updateProfileRequestSchema } } },
  },
  responses: {
    200: jsonResponse('Updated profile', profileSchema),
    403: jsonResponse('Not your profile', errorSchema),
    404: jsonResponse('Not found', errorSchema),
  },
});

const relationResponses = {
  204: { description: 'Applied (idempotent)' },
  400: jsonResponse('Validation error (self-target)', errorSchema),
  403: jsonResponse('Blocked either way', errorSchema),
  404: jsonResponse('Target profile not found', errorSchema),
};

socialApi.registerPath({
  method: 'post',
  path: '/profiles/{userId}/follow',
  tags: ['relationships'],
  security: [{ bearerAuth: [] }],
  request: { params: idParams },
  responses: relationResponses,
});

socialApi.registerPath({
  method: 'delete',
  path: '/profiles/{userId}/follow',
  tags: ['relationships'],
  security: [{ bearerAuth: [] }],
  request: { params: idParams },
  responses: relationResponses,
});

socialApi.registerPath({
  method: 'post',
  path: '/profiles/{userId}/block',
  tags: ['relationships'],
  security: [{ bearerAuth: [] }],
  description: 'Blocks the target and removes existing follows in both directions.',
  request: { params: idParams },
  responses: relationResponses,
});

socialApi.registerPath({
  method: 'delete',
  path: '/profiles/{userId}/block',
  tags: ['relationships'],
  security: [{ bearerAuth: [] }],
  request: { params: idParams },
  responses: relationResponses,
});

socialApi.registerPath({
  method: 'get',
  path: '/profiles/{userId}/relationship',
  tags: ['relationships'],
  security: [{ bearerAuth: [] }],
  description:
    'Caller-relative relationship flags. Unknown targets return all-false flags rather than 404.',
  request: { params: idParams },
  responses: {
    200: jsonResponse('Relationship', relationshipSchema),
  },
});

socialApi.registerPath({
  method: 'get',
  path: '/profiles/{userId}/following',
  tags: ['relationships'],
  security: [{ bearerAuth: [] }],
  request: { params: idParams, query: pageQuery },
  responses: {
    200: jsonResponse('Following page (newest follows first)', profilePageSchema),
    404: jsonResponse('Not found', errorSchema),
  },
});

socialApi.registerPath({
  method: 'get',
  path: '/profiles/{userId}/followers',
  tags: ['relationships'],
  security: [{ bearerAuth: [] }],
  request: { params: idParams, query: pageQuery },
  responses: {
    200: jsonResponse('Followers page (newest followers first)', profilePageSchema),
    404: jsonResponse('Not found', errorSchema),
  },
});

// Internal endpoints: no version segment, service tokens only (spec 03).
socialApi.registerPath({
  method: 'get',
  path: '/internal/users/{userId}/followers/ids',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description: 'Follower id list for feed fanout (fanout worker).',
  request: { params: idParams },
  responses: { 200: jsonResponse('Follower ids', z.array(z.string().uuid())) },
});

socialApi.registerPath({
  method: 'get',
  path: '/internal/users/{userId}/relationships/{otherId}',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description:
    'Relationship flags between two users; consumers treat blocking || blockedBy as blocked-either-way (posts #5, workers #8).',
  request: { params: z.object({ userId: userIdSchema, otherId: userIdSchema }) },
  responses: { 200: jsonResponse('Relationship', relationshipSchema) },
});

socialApi.registerPath({
  method: 'get',
  path: '/internal/users/{userId}/blocked/ids',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description: 'Ids this user has blocked (feed #7, search #9 filtering).',
  request: { params: idParams },
  responses: { 200: jsonResponse('Blocked ids', z.array(z.string().uuid())) },
});

socialApi.registerPath({
  method: 'post',
  path: '/internal/profiles/lookup',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description: 'Bulk profile lookup for server-side hydration (feed #7); missing ids are omitted.',
  request: { body: { content: { 'application/json': { schema: profileLookupRequestSchema } } } },
  responses: {
    200: jsonResponse('Profiles', profileLookupResponseSchema),
  },
});

socialApi.registerPath({
  method: 'post',
  path: '/internal/reseed',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description:
    'Truncate profiles + graph (reset job); deterministic reseed runs via the seed script.',
  responses: { 200: jsonResponse('Acknowledged', z.object({ ok: z.boolean() })) },
});

// Internal admin endpoints (T10): read-only user inspection, admin-role-gated.
socialApi.registerPath({
  method: 'get',
  path: '/internal/admin/users',
  tags: ['admin'],
  security: [{ adminToken: [] }, { serviceToken: [] }],
  description:
    'Moderation user list: profiles with follow-graph counts, username-ascending, optional username filter.',
  request: { query: adminUsersListQuerySchema },
  responses: {
    200: jsonResponse('User page', adminUserPageSchema),
    400: jsonResponse('Invalid cursor or filter', errorSchema),
  },
});

socialApi.registerPath({
  method: 'get',
  path: '/internal/admin/users/{userId}/follow-graph',
  tags: ['admin'],
  security: [{ adminToken: [] }, { serviceToken: [] }],
  description:
    'One user, their graph counts, and the first pages of followers and following (inspection only - no mutation routes exist).',
  request: { params: idParams },
  responses: {
    200: jsonResponse('Follow graph', adminFollowGraphSchema),
    404: jsonResponse('User not found', errorSchema),
  },
});
