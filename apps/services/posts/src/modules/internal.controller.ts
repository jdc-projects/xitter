import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Internal } from '@xitter/auth-nest';
import { postLookupRequestSchema, type PostLookupRequest } from '@xitter/api-contracts';
import { ZodValidationPipe } from '@xitter/service-kit';
import { PostsService } from './posts.service.js';

/**
 * Service-to-service endpoints (spec 03 internal table). No version segment -
 * they sit at /api/posts/internal/... and require a service token whose
 * audience is svc-posts (global AuthGuard via `@Internal()`).
 */
@Controller('internal')
export class InternalController {
  constructor(private readonly posts: PostsService) {}

  @Post('reseed')
  @Internal()
  // 200 to match the documented contract (spec 03 / OpenAPI registry).
  @HttpCode(200)
  reseed(): Promise<{ ok: boolean }> {
    return this.posts.reseed().then(() => ({ ok: true }));
  }

  /** Bulk visible-post lookup (feed #7 hydration). Deleted ids are omitted. */
  @Post('posts/lookup')
  @Internal()
  @HttpCode(200)
  lookup(@Body(new ZodValidationPipe(postLookupRequestSchema)) body: PostLookupRequest) {
    return this.posts.lookupPosts(body.postIds).then((items) => ({ items }));
  }
}
