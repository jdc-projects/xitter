import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Internal } from '@xitter/auth-nest';
import {
  mediaIdSchema,
  mediaLookupRequestSchema,
  recordVariantsRequestSchema,
  reportMediaFailureRequestSchema,
  type InternalMediaAsset,
  type MediaAsset,
  type MediaVariantCore,
} from '@xitter/api-contracts';
import { ZodValidationPipe } from '@xitter/service-kit';
import { MediaService } from './media.service.js';

const mediaIdParam = new ZodValidationPipe(mediaIdSchema);

/**
 * Service-to-service endpoints (spec 03 internal table). No version segment -
 * they sit at /api/media/internal/... and require a service token whose
 * audience is svc-media (global AuthGuard via `@Internal()`).
 */
@Controller('internal')
export class InternalController {
  constructor(private readonly media: MediaService) {}

  /** media-process worker: record variants → ready (idempotent). */
  @Post('media/:mediaId/variants')
  @Internal()
  @HttpCode(200)
  recordVariants(
    @Param('mediaId', mediaIdParam) mediaId: string,
    @Body(new ZodValidationPipe(recordVariantsRequestSchema)) body: { variants: MediaVariantCore[] },
  ): Promise<MediaAsset> {
    return this.media.recordVariants(mediaId, body.variants);
  }

  /** media-process worker: current asset state (redelivery idempotency). */
  @Get('media/:mediaId')
  @Internal()
  getAsset(@Param('mediaId', mediaIdParam) mediaId: string): Promise<InternalMediaAsset> {
    return this.media.getInternal(mediaId);
  }

  /** media-process worker: failed attempt (service owns the cap). */
  @Post('media/:mediaId/failure')
  @Internal()
  @HttpCode(200)
  reportFailure(
    @Param('mediaId', mediaIdParam) mediaId: string,
    @Body(new ZodValidationPipe(reportMediaFailureRequestSchema)) body: { error: string },
  ): Promise<MediaAsset> {
    return this.media.reportFailure(mediaId, body.error);
  }

  /** posts: resolve assets for attachment (existence, ownership, ready). */
  @Post('media/lookup')
  @Internal()
  @HttpCode(200)
  lookup(
    @Body(new ZodValidationPipe(mediaLookupRequestSchema)) body: { ownerId: string; mediaIds: string[] },
  ): Promise<{ items: MediaAsset[] }> {
    return this.media.lookup(body.ownerId, body.mediaIds).then((items) => ({ items }));
  }

  @Post('reseed')
  @Internal()
  // 200 to match the documented contract (spec 03 / OpenAPI registry).
  @HttpCode(200)
  reseed(): Promise<{ ok: boolean }> {
    return this.media.reseed().then(() => ({ ok: true }));
  }
}
