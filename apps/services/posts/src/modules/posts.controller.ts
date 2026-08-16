import { Controller, Get, Param, Post } from '@nestjs/common';
import { Internal, Public } from '@xitter/auth-nest';
import { PostsService } from './posts.service.js';

/**
 * Posts, replies, and interactions (likes, bookmarks, reposts).
 * Skeleton controller - zod validation and Kafka events land with the posts
 * feature ticket. Auth is enforced by the global AuthGuard (user tokens);
 * `@Internal()` routes require service (M2M) tokens.
 * Contract: docs/specs/architecture/03-service-interfaces.md.
 */
@Controller()
export class PostsController {
  constructor(private readonly service: PostsService) {}

  @Get('healthz')
  @Public()
  healthz() {
    return { status: 'ok' };
  }

  @Post('posts')
  create() {
    return this.service.placeholder();
  }

  @Post('posts/:postId/interactions')
  interact(@Param('postId') postId: string) {
    return this.service.placeholder(postId);
  }

  @Post('internal/reseed')
  @Internal()
  reseed() {
    return { ok: true };
  }
}
