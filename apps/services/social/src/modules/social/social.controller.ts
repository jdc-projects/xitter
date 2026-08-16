import { Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { InternalGuard, Public, RateLimit, RateLimitGuard } from '@xitter/auth-nest';
import { SocialService } from './social.service.js';

/**
 * Profiles, follows, and blocks.
 * Skeleton controller - request validation via zod pipes and Kafka events land
 * with the social feature ticket. Auth is enforced by the global AuthGuard
 * (user tokens); `internal/*` additionally requires service tokens.
 */
@Controller()
export class SocialController {
  constructor(private readonly social: SocialService) {}

  @Get('healthz')
  @Public()
  healthz() {
    return { status: 'ok' };
  }

  @Post('profiles/:userId/follow')
  @HttpCode(204)
  @UseGuards(RateLimitGuard)
  @RateLimit()
  follow(@Param('userId') userId: string) {
    this.social.follow(userId);
  }

  @Post('profiles/:userId/block')
  @HttpCode(204)
  block(@Param('userId') userId: string) {
    this.social.block(userId);
  }

  @Post('internal/reseed')
  @UseGuards(InternalGuard)
  reseed() {
    return { ok: true };
  }
}
