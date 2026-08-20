import { Controller, Get, Param, Query } from '@nestjs/common';
import { Internal } from '@xitter/auth-nest';
import { adminUsersListQuerySchema, userIdSchema, type AdminUsersListQuery } from '@xitter/api-contracts';
import { ZodValidationPipe } from '@xitter/service-kit';
import { SocialService } from './social.service.js';

const uuidParam = new ZodValidationPipe(userIdSchema);
const listQuery = new ZodValidationPipe(adminUsersListQuerySchema);

/**
 * Internal admin endpoints (T10, spec 03 §admin): user inspection for the
 * Refine panel - profiles with graph counts and the follow graph view.
 * Read-only: user content stays owned by users (AC 11.3), so there are no
 * mutation routes here.
 */
@Controller('internal/admin')
export class AdminController {
  constructor(private readonly social: SocialService) {}

  @Get('users')
  @Internal({ admin: true })
  users(@Query(listQuery) query: AdminUsersListQuery) {
    return this.social.adminUsers(query);
  }

  /** Profile + counts + first pages of followers/following. */
  @Get('users/:userId/follow-graph')
  @Internal({ admin: true })
  followGraph(@Param('userId', uuidParam) userId: string) {
    return this.social.adminFollowGraph(userId);
  }
}
