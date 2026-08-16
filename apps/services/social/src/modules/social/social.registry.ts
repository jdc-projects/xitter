import { OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { profileSchema } from '@xitter/api-contracts';

extendZodWithOpenApi(z);

const profilePage = z.object({
  items: z.array(profileSchema),
  nextCursor: z.string().nullable(),
});

export const socialApi = new OpenAPIRegistry();

socialApi.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

socialApi.registerPath({
  method: 'get',
  path: '/profiles/{userId}',
  tags: ['profiles'],
  request: { params: z.object({ userId: z.string().uuid() }) },
  responses: {
    200: { description: 'Profile', content: { 'application/json': { schema: profileSchema } } },
    404: { description: 'Not found' },
  },
});

socialApi.registerPath({
  method: 'get',
  path: '/profiles/username/{username}',
  tags: ['profiles'],
  request: { params: z.object({ username: z.string() }) },
  responses: {
    200: { description: 'Profile', content: { 'application/json': { schema: profileSchema } } },
    404: { description: 'Not found' },
  },
});

socialApi.registerPath({
  method: 'post',
  path: '/profiles/{userId}/follow',
  tags: ['relationships'],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ userId: z.string().uuid() }) },
  responses: { 204: { description: 'Following' }, 409: { description: 'Conflict' } },
});

socialApi.registerPath({
  method: 'delete',
  path: '/profiles/{userId}/follow',
  tags: ['relationships'],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ userId: z.string().uuid() }) },
  responses: { 204: { description: 'Unfollowed' } },
});

socialApi.registerPath({
  method: 'post',
  path: '/profiles/{userId}/block',
  tags: ['relationships'],
  security: [{ bearerAuth: [] }],
  request: { params: z.object({ userId: z.string().uuid() }) },
  responses: { 204: { description: 'Blocked' } },
});

socialApi.registerPath({
  method: 'get',
  path: '/profiles/{userId}/following',
  tags: ['relationships'],
  request: { params: z.object({ userId: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Following page',
      content: { 'application/json': { schema: profilePage } },
    },
  },
});

socialApi.registerPath({
  method: 'get',
  path: '/profiles/{userId}/followers',
  tags: ['relationships'],
  request: { params: z.object({ userId: z.string().uuid() }) },
  responses: {
    200: {
      description: 'Followers page',
      content: { 'application/json': { schema: profilePage } },
    },
  },
});
