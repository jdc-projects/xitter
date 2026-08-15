import { Controller, Get } from "@nestjs/common";
import { FeedService } from "./feed.service.js";
/**
 * Materialised home feeds and real-time feed updates.
 * Skeleton controller - the feed feature ticket fills in pagination and
 * websockets. Contract: docs/specs/architecture/03-service-interfaces.md.
 */
@Controller()
export class FeedController {
  constructor(private readonly service: FeedService) {}

  @Get("feed")
  getFeed() {
    return this.service.placeholder();
  }
}
