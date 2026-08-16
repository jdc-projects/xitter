import { Controller, Get, Param, Post } from '@nestjs/common';
import { Internal, Public } from '@xitter/auth-nest';
import { MediaService } from './media.service.js';

/**
 * Image uploads: pre-signed URLs, metadata, RustFS-backed storage.
 * Skeleton controller - the media feature ticket fills in upload flows.
 * Auth is enforced by the global AuthGuard (user tokens); `@Internal()`
 * routes require service (M2M) tokens.
 * Contract: docs/specs/architecture/03-service-interfaces.md.
 */
@Controller()
export class MediaController {
  constructor(private readonly service: MediaService) {}

  @Get('healthz')
  @Public()
  healthz() {
    return { status: 'ok' };
  }

  @Post('uploads')
  createUpload() {
    return this.service.placeholder();
  }

  @Post('media/:mediaId/complete')
  complete(@Param('mediaId') mediaId: string) {
    return this.service.getMedia(mediaId);
  }

  @Post('internal/reseed')
  @Internal()
  reseed() {
    return { ok: true };
  }
}
