import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { RequestUser } from '@xitter/auth-nest';
import { CurrentUser, RateLimit, RateLimitGuard } from '@xitter/auth-nest';
import {
  createProfileRequestSchema,
  updateProfileRequestSchema,
  userIdSchema,
  usernameSchema,
  type Profile,
  type ProfileWithCounts,
  type Relationship,
} from '@xitter/api-contracts';
import { z } from 'zod';
import { SocialService } from './social.service.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const uuidParam = new ZodValidationPipe(userIdSchema);
const usernameParam = new ZodValidationPipe(usernameSchema);
const pageQuery = new ZodValidationPipe(
  z.object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
);

/**
 * Public social API (spec 03): profiles, follow/block actions, relationship
 * view, paginated following/followers. The `v1` segment lives here (the
 * global prefix is service-level) so internal routes can go without it.
 * Mutations carry a Valkey token-bucket rate limit. Auth is user-Bearer via
 * the global AuthGuard.
 */
@Controller('v1')
export class SocialController {
  constructor(private readonly social: SocialService) {}

  @Post('profiles/:userId')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit()
  async createProfile(
    @CurrentUser() user: RequestUser,
    @Param('userId', uuidParam) targetId: string,
    @Body(new ZodValidationPipe(createProfileRequestSchema))
    body: {
      displayName?: string;
      bio?: string | null;
    },
  ): Promise<Profile> {
    if (targetId !== user.subject) {
      throw new ForbiddenException({
        error: { code: 'FORBIDDEN', message: 'Profile id must be the caller' },
      });
    }
    const { profile } = await this.social.ensureProfile(
      { id: user.subject, username: user.username },
      body,
    );
    return profile;
  }

  @Get('profiles/:userId')
  async getProfile(@Param('userId', uuidParam) targetId: string): Promise<ProfileWithCounts> {
    const { profile, counts } = await this.social.getProfile(targetId);
    return { ...profile, counts };
  }

  @Get('profiles/username/:username')
  async getProfileByUsername(@Param('username', usernameParam) username: string): Promise<Profile> {
    return this.social.getProfileByUsername(username);
  }

  @Patch('profiles/:userId')
  @UseGuards(RateLimitGuard)
  @RateLimit()
  updateProfile(
    @CurrentUser() user: RequestUser,
    @Param('userId', uuidParam) targetId: string,
    @Body(new ZodValidationPipe(updateProfileRequestSchema))
    body: {
      displayName?: string;
      bio?: string | null;
    },
  ): Promise<Profile> {
    return this.social.updateProfile(user.subject, targetId, body);
  }

  @Post('profiles/:userId/follow')
  @HttpCode(204)
  @UseGuards(RateLimitGuard)
  @RateLimit()
  follow(@CurrentUser() user: RequestUser, @Param('userId', uuidParam) targetId: string) {
    return this.social.follow(user.subject, targetId);
  }

  @Delete('profiles/:userId/follow')
  @HttpCode(204)
  @UseGuards(RateLimitGuard)
  @RateLimit()
  unfollow(@CurrentUser() user: RequestUser, @Param('userId', uuidParam) targetId: string) {
    return this.social.unfollow(user.subject, targetId);
  }

  @Post('profiles/:userId/block')
  @HttpCode(204)
  @UseGuards(RateLimitGuard)
  @RateLimit()
  block(@CurrentUser() user: RequestUser, @Param('userId', uuidParam) targetId: string) {
    return this.social.block(user.subject, targetId);
  }

  @Delete('profiles/:userId/block')
  @HttpCode(204)
  @UseGuards(RateLimitGuard)
  @RateLimit()
  unblock(@CurrentUser() user: RequestUser, @Param('userId', uuidParam) targetId: string) {
    return this.social.unblock(user.subject, targetId);
  }

  @Get('profiles/:userId/relationship')
  relationship(
    @CurrentUser() user: RequestUser,
    @Param('userId', uuidParam) targetId: string,
  ): Promise<Relationship> {
    return this.social.relationship(user.subject, targetId);
  }

  @Get('profiles/:userId/following')
  following(
    @Param('userId', uuidParam) targetId: string,
    @Query(pageQuery) page: { cursor?: string; limit: number },
  ) {
    return this.social.following(targetId, page);
  }

  @Get('profiles/:userId/followers')
  followers(
    @Param('userId', uuidParam) targetId: string,
    @Query(pageQuery) page: { cursor?: string; limit: number },
  ) {
    return this.social.followers(targetId, page);
  }
}
