import { OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { postSchema, profileSchema } from '@xitter/api-contracts';

extendZodWithOpenApi(z);

const searchPage = z.object({
  items: z.array(z.object({ post: postSchema, author: profileSchema })),
  nextCursor: z.string().nullable(),
});

export const searchApi = new OpenAPIRegistry();

searchApi.registerPath({
  method: 'get',
  path: '/posts',
  tags: ['search'],
  request: { query: z.object({ q: z.string().min(1), cursor: z.string().optional() }) },
  responses: {
    200: {
      description: 'Search results page',
      content: { 'application/json': { schema: searchPage } },
    },
  },
});
