import { Controller, Get, Post } from '@nestjs/common';
import { Internal } from '@xitter/auth-nest';
import { FeedService } from './feed.service.js';
/**
 * Materialised home feeds and real-time feed updates.
 * Skeleton controller - the feed feature ticket fills in pagination and
 * websockets. Auth is enforced by the global AuthGuard (user tokens);
 * `@Internal()` routes require service (M2M) tokens.
 * Contract: docs/specs/architecture/03-service-interfaces.md.
 */
@Controller()
export class FeedController {
  constructor(private readonly service: FeedService) {}

  @Get('feed')
  getFeed() {
    return this.service.placeholder();
  }

  @Post('internal/reseed')
  @Internal()
  reseed() {
    return { ok: true };
  }
}
