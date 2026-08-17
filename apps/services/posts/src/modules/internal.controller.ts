import { Controller, Post } from '@nestjs/common';
import { Internal } from '@xitter/auth-nest';
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
  reseed(): Promise<{ ok: boolean }> {
    return this.posts.reseed().then(() => ({ ok: true }));
  }
}
