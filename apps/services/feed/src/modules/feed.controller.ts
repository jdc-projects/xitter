import { Controller, Get, HttpCode, Query } from '@nestjs/common';
import type { RequestUser } from '@xitter/auth-nest';
import { CurrentUser } from '@xitter/auth-nest';
import { badRequest } from '@xitter/service-kit';
import { z } from 'zod';
import { FeedService } from './feed.service.js';

const pageQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/**
 * Public feed API (spec 03): the materialised home timeline plus the
 * websocket notification endpoint. The `v1` segment lives here (the global
 * prefix is service-level). Auth is user-Bearer via the global AuthGuard.
 */
@Controller('v1')
export class FeedController {
  constructor(private readonly feed: FeedService) {}

  @Get('feed')
  getFeed(
    @CurrentUser() user: RequestUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = pageQuery.safeParse({ cursor, limit });
    if (!parsed.success) {
      throw badRequest('Query validation failed', { fields: parsed.error.flatten() });
    }
    return this.feed.getFeed(user.subject, parsed.data);
  }

  /**
   * The WS endpoint proper never answers plain HTTP - the gateway owns the
   * upgrade on this path. This documents the contract for anyone who GETs
   * it and keeps the path out of the 404s.
   */
  @Get('ws')
  @HttpCode(400)
  ws() {
    return {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'WebSocket endpoint: connect via wss upgrade with a ?token= access token',
      },
    };
  }
}
