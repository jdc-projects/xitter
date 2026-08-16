import { OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { createMediaUploadRequestSchema } from '@xitter/api-contracts';

extendZodWithOpenApi(z);

export const mediaApi = new OpenAPIRegistry();

mediaApi.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

mediaApi.registerPath({
  method: 'post',
  path: '/uploads',
  tags: ['media'],
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: createMediaUploadRequestSchema } } },
  },
  responses: {
    201: {
      description: 'Upload slot created; upload bytes to the returned URL',
      content: {
        'application/json': {
          schema: z.object({ mediaId: z.string().uuid(), uploadUrl: z.string().url() }),
        },
      },
    },
    413: { description: 'Too large' },
  },
});
