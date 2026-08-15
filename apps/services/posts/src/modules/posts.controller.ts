import { Controller, Param, Post } from '@nestjs/common';
import { PostsService } from './posts.service.js';

/**
 * Posts, replies, and interactions (likes, bookmarks, reposts).
 * Skeleton controller - zod validation, auth guard, and Kafka events land with
 * the posts feature ticket. Contract: docs/specs/architecture/03-service-interfaces.md.
 */
@Controller()
export class PostsController {
  constructor(private readonly service: PostsService) {}

  @Post('posts')
  create() {
    return this.service.placeholder();
  }

  @Post('posts/:postId/interactions')
  interact(@Param('postId') postId: string) {
    return this.service.placeholder(postId);
  }
}
