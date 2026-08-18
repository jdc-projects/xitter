import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { RequestUser } from '@xitter/auth-nest';
import { CurrentUser, RateLimit, RateLimitGuard } from '@xitter/auth-nest';
import {
  createPostRequestSchema,
  postIdSchema,
  userIdSchema,
  type CreatePostRequest,
  type Post as PostDto,
} from '@xitter/api-contracts';
import { z } from 'zod';
import { PostsService, type PostPage } from './posts.service.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const uuidParam = new ZodValidationPipe(postIdSchema);
const userParam = new ZodValidationPipe(userIdSchema);
const pageQuery = new ZodValidationPipe(
  z.object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
);

/**
 * Public posts API (spec 03): create/delete, hydrated reads, author
 * timelines, reply threads. The `v1` segment lives here (the global prefix
 * is service-level) so internal routes can go without it. Mutations carry a
 * Valkey token-bucket rate limit. Auth is user-Bearer via the global
 * AuthGuard.
 */
@Controller('v1')
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  /**
   * mediaIds are shape-checked only (uuid, max 4): existence/status
   * validation lands with the media ticket (#6).
   */
  @Post('posts')
  @UseGuards(RateLimitGuard)
  @RateLimit()
  create(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(createPostRequestSchema)) body: CreatePostRequest,
  ): Promise<PostDto> {
    return this.posts.create(user.subject, body);
  }

  @Delete('posts/:postId')
  @HttpCode(204)
  @UseGuards(RateLimitGuard)
  @RateLimit()
  remove(@CurrentUser() user: RequestUser, @Param('postId', uuidParam) postId: string) {
    return this.posts.remove(user.subject, postId);
  }

  @Get('posts/:postId')
  get(@Param('postId', uuidParam) postId: string): Promise<PostDto> {
    return this.posts.getPost(postId);
  }

  @Get('users/:userId/posts')
  userPosts(
    @Param('userId', userParam) userId: string,
    @Query(pageQuery) page: { cursor?: string; limit: number },
  ): Promise<PostPage> {
    return this.posts.userPosts(userId, page);
  }

  @Get('posts/:postId/replies')
  replies(
    @Param('postId', uuidParam) postId: string,
    @Query(pageQuery) page: { cursor?: string; limit: number },
  ): Promise<PostPage> {
    return this.posts.postReplies(postId, page);
  }
}
