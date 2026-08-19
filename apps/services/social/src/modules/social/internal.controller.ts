import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Internal } from '@xitter/auth-nest';
import {
  profileLookupRequestSchema,
  userIdSchema,
  type Profile,
  type ProfileLookupRequest,
  type Relationship,
} from '@xitter/api-contracts';
import { ZodValidationPipe } from '@xitter/service-kit';
import { SocialService } from './social.service.js';

const uuidParam = new ZodValidationPipe(userIdSchema);

/**
 * Service-to-service endpoints (spec 03 internal table). No version segment -
 * they sit at /api/social/internal/... and require a service token whose
 * audience is svc-social (global AuthGuard via `@Internal()`).
 */
@Controller('internal')
export class InternalController {
  constructor(private readonly social: SocialService) {}

  @Get('users/:userId/followers/ids')
  @Internal()
  followerIds(@Param('userId', uuidParam) userId: string): Promise<string[]> {
    return this.social.followerIds(userId);
  }

  /** Blocked-either-way check used by posts (#5) and workers (#8). */
  @Get('users/:userId/relationships/:otherId')
  @Internal()
  relationship(
    @Param('userId', uuidParam) userId: string,
    @Param('otherId', uuidParam) otherId: string,
  ): Promise<Relationship> {
    return this.social.relationshipPair(userId, otherId);
  }

  /** Blocked-id list used by feed (#7) and search (#9) filtering. */
  @Get('users/:userId/blocked/ids')
  @Internal()
  blockedIds(@Param('userId', uuidParam) userId: string): Promise<string[]> {
    return this.social.blockedIds(userId);
  }

  /** Bulk profile lookup for server-side hydration (feed #7). */
  @Post('profiles/lookup')
  @Internal()
  @HttpCode(200)
  lookupProfiles(
    @Body(new ZodValidationPipe(profileLookupRequestSchema)) body: ProfileLookupRequest,
  ): Promise<{ items: Profile[] }> {
    return this.social.profilesByIds(body.userIds).then((items) => ({ items }));
  }

  @Post('reseed')
  @Internal()
  // 200 to match the documented contract (spec 03 / OpenAPI registry).
  @HttpCode(200)
  reseed(): Promise<{ ok: boolean }> {
    return this.social.reseed().then(() => ({ ok: true }));
  }
}
