import { Controller, Delete, Get, HttpCode, Param, Query, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  Internal,
  RateLimit,
  RateLimitGuard,
  type RequestUser,
} from '@xitter/auth-nest';
import {
  adminMediaListQuerySchema,
  mediaIdSchema,
  type AdminMediaListQuery,
} from '@xitter/api-contracts';
import { ZodValidationPipe } from '@xitter/service-kit';
import { z } from 'zod';
import { MediaService } from './media.service.js';

const mediaIdParam = new ZodValidationPipe(mediaIdSchema);
const listQuery = new ZodValidationPipe(adminMediaListQuerySchema);
const auditQuery = new ZodValidationPipe(
  z.object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
);

/**
 * Internal admin endpoints (T10, spec 03 §admin): media moderation from the
 * Refine panel - list with filters, inspect storage coordinates, delete
 * (cascades RustFS object removal via this service, the storage owner).
 */
@Controller('internal/admin')
export class AdminController {
  constructor(private readonly media: MediaService) {}

  @Get('media')
  @Internal({ admin: true })
  list(@Query(listQuery) query: AdminMediaListQuery) {
    return this.media.adminList(query);
  }

  @Get('media/:mediaId')
  @Internal({ admin: true })
  show(@Param('mediaId', mediaIdParam) mediaId: string) {
    return this.media.adminGet(mediaId);
  }

  @Delete('media/:mediaId')
  @HttpCode(204)
  @Internal({ admin: true })
  @UseGuards(RateLimitGuard)
  @RateLimit()
  remove(
    @CurrentUser() user: RequestUser,
    @Param('mediaId', mediaIdParam) mediaId: string,
  ) {
    return this.media.adminDelete(
      { actorId: user.subject, actorName: user.username },
      mediaId,
    );
  }

  @Get('audit')
  @Internal({ admin: true })
  audit(@Query(auditQuery) page: { cursor?: string; limit: number }) {
    return this.media.adminAudit(page);
  }
}
