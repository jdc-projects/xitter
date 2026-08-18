import { OpenAPIRegistry, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  createMediaUploadRequestSchema,
  createMediaUploadResponseSchema,
  errorSchema,
  internalMediaAssetSchema,
  mediaAssetSchema,
  mediaIdSchema,
  mediaLookupRequestSchema,
  recordVariantsRequestSchema,
} from '@xitter/api-contracts';

extendZodWithOpenApi(z);

const mediaParams = z.object({ mediaId: mediaIdSchema });

const jsonResponse = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});

export const mediaApi = new OpenAPIRegistry();

mediaApi.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

mediaApi.registerComponent('securitySchemes', 'serviceToken', {
  type: 'http',
  scheme: 'bearer',
  description: 'Client-credentials service token (audience = svc-media).',
});

mediaApi.registerPath({
  method: 'post',
  path: '/uploads',
  tags: ['media'],
  security: [{ bearerAuth: [] }],
  description:
    'Create an upload slot for one image. The mime allowlist (png/jpeg/webp/gif, 415) and the 5MB cap (413) are enforced here; the response carries a presigned PUT URL for RustFS (15 min - SigV4 binds the host only, so the stored content type is re-checked at completion).',
  request: {
    body: { content: { 'application/json': { schema: createMediaUploadRequestSchema } } },
  },
  responses: {
    201: jsonResponse(
      'Upload slot created; PUT bytes to uploadUrl',
      createMediaUploadResponseSchema,
    ),
    400: jsonResponse('Validation error', errorSchema),
    413: jsonResponse('Over the 5MB cap', errorSchema),
    415: jsonResponse('Unsupported image type', errorSchema),
  },
});

mediaApi.registerPath({
  method: 'post',
  path: '/media/{mediaId}/complete',
  tags: ['media'],
  security: [{ bearerAuth: [] }],
  description:
    'Confirm the browser PUT finished. The service HEADs the exact object key server-side (and re-checks the real size) before emitting `media.media.uploaded`; a client-asserted success is never trusted. Idempotent - a repeated complete does not re-emit.',
  request: { params: mediaParams },
  responses: {
    200: jsonResponse('Asset (status pending until the worker records variants)', mediaAssetSchema),
    400: jsonResponse('Object missing / still uploading, or failed processing', errorSchema),
    404: jsonResponse('Not found (or not yours)', errorSchema),
  },
});

mediaApi.registerPath({
  method: 'get',
  path: '/media/{mediaId}',
  tags: ['media'],
  security: [{ bearerAuth: [] }],
  description: 'Media metadata incl. variant URLs (`original`, `thumb`) under `/media`.',
  request: { params: mediaParams },
  responses: {
    200: jsonResponse('Media asset', mediaAssetSchema),
    404: jsonResponse('Not found', errorSchema),
  },
});

// Internal endpoints: no version segment, service tokens only (spec 03).
mediaApi.registerPath({
  method: 'post',
  path: '/internal/media/lookup',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description:
    'Resolve assets for post attachment: returns the assets among mediaIds that exist AND are owned by ownerId. Callers (posts) enforce ready-status on the response.',
  request: { body: { content: { 'application/json': { schema: mediaLookupRequestSchema } } } },
  responses: {
    200: jsonResponse(
      'Owned assets (possibly fewer than requested)',
      z.object({ items: z.array(mediaAssetSchema) }),
    ),
  },
});

mediaApi.registerPath({
  method: 'post',
  path: '/internal/media/{mediaId}/variants',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description:
    'media-process worker: record processed variants and flip the asset to ready (emits `media.media.processed`). Idempotent on redelivery.',
  request: {
    params: mediaParams,
    body: { content: { 'application/json': { schema: recordVariantsRequestSchema } } },
  },
  responses: {
    200: jsonResponse('Updated asset', mediaAssetSchema),
    404: jsonResponse('Not found', errorSchema),
  },
});

mediaApi.registerPath({
  method: 'get',
  path: '/internal/media/{mediaId}',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description:
    'media-process worker: current asset state (status, objectKey, mimeType, attempts) so redeliveries skip already-processed or failed assets.',
  request: { params: mediaParams },
  responses: {
    200: jsonResponse('Asset (internal view)', internalMediaAssetSchema),
    404: jsonResponse('Not found', errorSchema),
  },
});

mediaApi.registerPath({
  method: 'post',
  path: '/internal/media/{mediaId}/failure',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description:
    'media-process worker: report a processing failure. The service bumps the attempt counter and marks the asset failed at the cap (3); the response status tells the worker whether to let Kafka redeliver.',
  request: {
    params: mediaParams,
    body: { content: { 'application/json': { schema: z.object({ error: z.string().min(1) }) } } },
  },
  responses: {
    200: jsonResponse('Asset (pending until the cap, then failed)', mediaAssetSchema),
    404: jsonResponse('Not found', errorSchema),
  },
});

mediaApi.registerPath({
  method: 'post',
  path: '/internal/reseed',
  tags: ['internal'],
  security: [{ serviceToken: [] }],
  description:
    'Truncate media metadata (reset job); bucket contents are wiped by the reset itself.',
  responses: { 200: jsonResponse('Acknowledged', z.object({ ok: z.boolean() })) },
});
