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
  createInteractionRequestSchema,
  createPostRequestSchema,
  interactionKindSchema,
  postIdSchema,
  pageQuerySchema,
  userIdSchema,
  viewerStateQuerySchema,
  type CreateInteractionRequest,
  type CreatePostRequest,
  type InteractionKind,
  type Post as PostDto,
} from '@xitter/api-contracts';
import { ZodValidationPipe } from '@xitter/service-kit';
import { PostsService, type PostPage } from './posts.service.js';

const uuidParam = new ZodValidationPipe(postIdSchema);
const kindParam = new ZodValidationPipe(interactionKindSchema);
const userParam = new ZodValidationPipe(userIdSchema);
const pageQuery = new ZodValidationPipe(pageQuerySchema);
const viewerStateQuery = new ZodValidationPipe(viewerStateQuerySchema);

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
   * mediaIds resolve through media's internal lookup: existence, ownership
   * and ready-status (spec 03); non-ready ids 400 with the offenders listed.
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

  /** Like/bookmark/repost: idempotent; blocked callers 403 (#8, product 6.4). */
  @Post('posts/:postId/interactions')
  @UseGuards(RateLimitGuard)
  @RateLimit()
  interact(
    @CurrentUser() user: RequestUser,
    @Param('postId', uuidParam) postId: string,
    @Body(new ZodValidationPipe(createInteractionRequestSchema)) body: CreateInteractionRequest,
  ) {
    return this.posts.interact(user.subject, postId, body.kind);
  }

  /** Undo an own interaction: idempotent 204. */
  @Delete('posts/:postId/interactions/:kind')
  @HttpCode(204)
  @UseGuards(RateLimitGuard)
  @RateLimit()
  removeInteraction(
    @CurrentUser() user: RequestUser,
    @Param('postId', uuidParam) postId: string,
    @Param('kind', kindParam) kind: InteractionKind,
  ): Promise<void> {
    return this.posts.removeInteraction(user.subject, postId, kind);
  }

  /** The caller's private bookmark list, newest first. */
  @Get('bookmarks')
  bookmarks(
    @CurrentUser() user: RequestUser,
    @Query(pageQuery) page: { cursor?: string; limit: number },
  ): Promise<PostPage> {
    return this.posts.bookmarks(user.subject, page);
  }

  /** Batched viewer flags (like/repost/bookmark) for list rendering (#8). */
  @Get('viewer-state')
  viewerState(
    @CurrentUser() user: RequestUser,
    @Query(viewerStateQuery) query: { postIds: string[] },
  ) {
    return this.posts.viewerState(user.subject, query.postIds).then((items) => ({ items }));
  }
}
