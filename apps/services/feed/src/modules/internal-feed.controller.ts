import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { Internal } from '@xitter/auth-nest';
import {
  upsertFeedEntriesRequestSchema,
  userIdSchema,
  postIdSchema,
  type ResetStatus,
  type UpsertFeedEntriesRequest,
} from '@xitter/api-contracts';
import { ZodValidationPipe } from '@xitter/service-kit';
import { FeedService } from './feed.service.js';
import { RESET_STATUS, type ResetStatusReader } from './reset-status.js';

const uuidParam = new ZodValidationPipe(userIdSchema);
const postParam = new ZodValidationPipe(postIdSchema);

/**
 * Service-to-service endpoints (spec 03 internal table): the fanout worker
 * materialises/removes entries; the reset job wipes state. No version
 * segment - they sit at /api/feed/internal/... and require a service token
 * whose audience is svc-feed (global AuthGuard via `@Internal()`).
 */
@Controller('internal')
export class InternalFeedController {
  constructor(
    private readonly feed: FeedService,
    @Inject(RESET_STATUS) private readonly resetStatusReader: ResetStatusReader,
  ) {}

  /** Bulk idempotent entry upsert (spec 04 natural-key rule). */
  @Post('feed/entries')
  @Internal()
  @HttpCode(200)
  upsertEntries(
    @Body(new ZodValidationPipe(upsertFeedEntriesRequestSchema)) body: UpsertFeedEntriesRequest,
  ) {
    return this.feed.upsertEntries(body.entries);
  }

  /** Post deleted: entries for the post leave every feed. */
  @Delete('feed/posts/:postId/entries')
  @Internal()
  deletePostEntries(@Param('postId', postParam) postId: string) {
    return this.feed.deletePostEntries(postId);
  }

  /** Repost undone: only that reposter's repost entries go (#8). */
  @Delete('feed/posts/:postId/reposts/:repostedById')
  @Internal()
  deleteRepostEntries(
    @Param('postId', postParam) postId: string,
    @Param('repostedById', uuidParam) repostedById: string,
  ) {
    return this.feed.deleteRepostEntries(postId, repostedById);
  }

  /** Unfollowed: the author's entries leave this one feed. */
  @Delete('feed/users/:userId/authors/:authorId')
  @Internal()
  deleteAuthorEntries(
    @Param('userId', uuidParam) userId: string,
    @Param('authorId', uuidParam) authorId: string,
  ) {
    return this.feed.deleteAuthorEntries(userId, authorId);
  }

  /** Feed reset for one user (spec 03: reset job / fanout). */
  @Delete('feed/users/:userId')
  @Internal()
  resetUser(@Param('userId', uuidParam) userId: string) {
    return this.feed.resetUser(userId);
  }

  @Post('reseed')
  @Internal()
  // 200 to match the documented contract (spec 03 / OpenAPI registry).
  @HttpCode(200)
  reseed() {
    return this.feed.reseed().then((r) => ({ ok: true, deleted: r.deleted }));
  }

  /**
   * Last reset/reseed run (T13): the reset job's record, for the admin
   * health tile. Null = no reset recorded (e.g. a fresh local env).
   */
  @Get('reset-status')
  @Internal()
  resetStatus(): Promise<ResetStatus | null> {
    return this.resetStatusReader.latest();
  }
}
