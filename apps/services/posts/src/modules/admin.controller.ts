import { Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  Internal,
  RateLimit,
  RateLimitGuard,
  type RequestUser,
} from '@xitter/auth-nest';
import {
  adminDeletePostQuerySchema,
  adminPostsListQuerySchema,
  postIdSchema,
  type AdminDeletePostQuery,
  type AdminPostsListQuery,
} from '@xitter/api-contracts';
import { ZodValidationPipe } from '@xitter/service-kit';
import { z } from 'zod';
import { PostsService } from './posts.service.js';

const uuidParam = new ZodValidationPipe(postIdSchema);
const listQuery = new ZodValidationPipe(adminPostsListQuerySchema);
const deleteQuery = new ZodValidationPipe(adminDeletePostQuerySchema);
const auditQuery = new ZodValidationPipe(
  z.object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
);

/**
 * Internal admin endpoints (T10, spec 03 §admin): moderation of posts from
 * the Refine panel. Admin-role-gated (`@Internal({ admin: true })` - the
 * panel's admin-realm user token or the svc-admin machine client; the guard
 * owns that decision). Mutations carry the shared rate limit: an admin UI
 * bug should not be able to hammer deletes.
 */
@Controller('internal/admin')
export class AdminController {
  constructor(private readonly posts: PostsService) {}

  @Get('posts')
  @Internal({ admin: true })
  list(@Query(listQuery) query: AdminPostsListQuery) {
    return this.posts.adminListPosts(query);
  }

  @Get('posts/:postId')
  @Internal({ admin: true })
  show(@Param('postId', uuidParam) postId: string) {
    return this.posts.adminGetPost(postId);
  }

  @Delete('posts/:postId')
  @HttpCode(204)
  @Internal({ admin: true })
  @UseGuards(RateLimitGuard)
  @RateLimit()
  remove(
    @CurrentUser() user: RequestUser,
    @Param('postId', uuidParam) postId: string,
    @Query(deleteQuery) query: AdminDeletePostQuery,
  ) {
    return this.posts.adminRemovePost(
      { actorId: user.subject, actorName: user.username },
      postId,
      query.hard === 'true',
    );
  }

  @Post('posts/:postId/restore')
  @HttpCode(200)
  @Internal({ admin: true })
  @UseGuards(RateLimitGuard)
  @RateLimit()
  restore(@CurrentUser() user: RequestUser, @Param('postId', uuidParam) postId: string) {
    return this.posts.adminRestorePost({ actorId: user.subject, actorName: user.username }, postId);
  }

  @Get('audit')
  @Internal({ admin: true })
  audit(@Query(auditQuery) page: { cursor?: string; limit: number }) {
    return this.posts.adminAudit(page);
  }
}
