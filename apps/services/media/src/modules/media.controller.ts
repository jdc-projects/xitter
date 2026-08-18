import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import type { RequestUser } from '@xitter/auth-nest';
import { CurrentUser, RateLimit, RateLimitGuard } from '@xitter/auth-nest';
import {
  createMediaUploadRequestSchema,
  mediaIdSchema,
  type CreateMediaUploadRequest,
  type CreateMediaUploadResponse,
  type MediaAsset,
} from '@xitter/api-contracts';
import { ZodValidationPipe } from '@xitter/service-kit';
import { MediaService } from './media.service.js';

const mediaIdParam = new ZodValidationPipe(mediaIdSchema);

/**
 * Public media API (spec 03): upload slots, completion, metadata. The `v1`
 * segment lives here (the global prefix is service-level) so internal
 * routes can go without it. Binaries never transit this service - the
 * browser PUTs to RustFS via the presigned URL. Mutations are rate-limited.
 */
@Controller('v1')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  /** Slot creation enforces the mime allowlist (415) and 5MB cap (413). */
  @Post('uploads')
  @UseGuards(RateLimitGuard)
  @RateLimit()
  createUpload(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createMediaUploadRequestSchema)) body: CreateMediaUploadRequest,
  ): Promise<CreateMediaUploadResponse> {
    return this.media.createUpload(user.subject, body);
  }

  /** Completion HEADs the object before emitting `media.media.uploaded`. */
  @Post('media/:mediaId/complete')
  @UseGuards(RateLimitGuard)
  @RateLimit()
  @HttpCode(200)
  complete(
    @CurrentUser() user: RequestUser,
    @Param('mediaId', mediaIdParam) mediaId: string,
  ): Promise<MediaAsset> {
    return this.media.complete(user.subject, mediaId);
  }

  /** Metadata incl. variant URLs under `/media` (rendering + polling). */
  @Get('media/:mediaId')
  get(@Param('mediaId', mediaIdParam) mediaId: string): Promise<MediaAsset> {
    return this.media.getMedia(mediaId);
  }
}
