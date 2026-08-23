import { Controller, Get, Query } from '@nestjs/common';
import type { RequestUser } from '@xitter/auth-nest';
import { CurrentUser } from '@xitter/auth-nest';
import { pageQuerySchema } from '@xitter/api-contracts';
import { badRequest } from '@xitter/service-kit';
import { z } from 'zod';
import { SearchService } from './search.service.js';

const searchQuery = pageQuerySchema.extend({ q: z.string().min(1).max(512) });

/**
 * Public search API (spec 03): full-text post search, cursor-paginated,
 * hydrated server-side (posts + social joins). The `v1` segment lives here
 * (the global prefix is service-level). Auth is user-Bearer via the global
 * AuthGuard.
 */
@Controller('v1')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get('posts')
  searchPosts(
    @CurrentUser() user: RequestUser,
    @Query('q') q?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = searchQuery.safeParse({ q, cursor, limit });
    if (!parsed.success) {
      throw badRequest('Query validation failed', { fields: parsed.error.flatten() });
    }
    return this.search.searchPosts(user.subject, parsed.data);
  }
}
