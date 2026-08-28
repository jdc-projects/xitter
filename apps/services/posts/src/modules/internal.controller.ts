import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { Internal } from '@xitter/auth-nest';
import {
  internalAuthorPostsRequestSchema,
  internalCreatePostRequestSchema,
  internalViewerStateQuerySchema,
  postLookupRequestSchema,
  type InternalAuthorPostsRequest,
  type InternalCreatePostRequest,
  type InternalViewerStateQuery,
  type PostLookupRequest,
} from '@xitter/api-contracts';
import { ZodValidationPipe } from '@xitter/service-kit';
import { PostsService } from './posts.service.js';

const internalViewerStateQuery = new ZodValidationPipe(internalViewerStateQuerySchema);

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

  /**
   * Batched viewer flags by user id (#157): the feed service folds these
   * into its pages so the web renders a feed in one hop instead of
   * feed-then-viewer-state. M2M (svc-* audience), same service method the
   * user-facing endpoint uses.
   */
  @Get('posts/viewer-state')
  @Internal()
  viewerState(@Query(internalViewerStateQuery) query: InternalViewerStateQuery) {
    return this.posts.viewerState(query.userId, query.postIds).then((items) => ({ items }));
  }

  /**
   * Seed-only create on behalf of a user with an explicit creation time
   * (#150: the corpus's back-dated timestamps). Same rules as the public
   * create (the service path is shared), plus a bounded past-only window on
   * `createdAt`. Scoped to the seeder's machine client (svc-reset) - public
   * callers keep the timestamp-less POST /v1/posts.
   */
  @Post('posts')
  @Internal({ clients: ['svc-reset'] })
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(internalCreatePostRequestSchema)) body: InternalCreatePostRequest,
  ) {
    const { authorId, createdAt, ...post } = body;
    return this.posts.create(authorId, post, { createdAt });
  }

  /** Bulk visible-post lookup (feed #7 hydration). Deleted ids are omitted. */
  @Post('posts/lookup')
  @Internal()
  @HttpCode(200)
  lookup(@Body(new ZodValidationPipe(postLookupRequestSchema)) body: PostLookupRequest) {
    return this.posts.lookupPosts(body.postIds).then((items) => ({ items }));
  }

  /**
   * Author timeline for the follow backfill (fanout worker #7). The public
   * timeline requires a user token; workers hold service tokens.
   */
  @Post('posts/by-author')
  @Internal()
  @HttpCode(200)
  byAuthor(
    @Body(new ZodValidationPipe(internalAuthorPostsRequestSchema)) body: InternalAuthorPostsRequest,
  ) {
    return this.posts.userPosts(body.authorId, { cursor: body.cursor, limit: body.limit ?? 20 });
  }
}
