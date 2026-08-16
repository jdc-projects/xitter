import { Controller, Get, Post } from '@nestjs/common';
import { Internal } from '@xitter/auth-nest';
import { SearchService } from './search.service.js';

/**
 * Full-text search over posts, backed by OpenSearch.
 * Skeleton controller - the search feature ticket fills in querying.
 * Auth is enforced by the global AuthGuard (user tokens); `@Internal()`
 * routes require service (M2M) tokens.
 * Contract: docs/specs/architecture/03-service-interfaces.md.
 */
@Controller()
export class SearchController {
  constructor(private readonly service: SearchService) {}

  @Get('posts')
  search() {
    return this.service.placeholder();
  }

  @Post('internal/reseed')
  @Internal()
  reseed() {
    return { ok: true };
  }
}
