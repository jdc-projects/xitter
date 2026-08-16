import { Body, Controller, Param, Post } from '@nestjs/common';
import { SocialService } from './social.service.js';

/**
 * Profiles, follows, and blocks.
 * Skeleton controller - request validation via zod pipes, auth guard, and
 * Kafka events land with the social feature ticket.
 */
@Controller()
export class SocialController {
  constructor(private readonly social: SocialService) {}

  @Post('profiles/:userId/follow')
  follow(@Param('userId') userId: string) {
    return this.social.follow(userId);
  }

  @Post('profiles/:userId/block')
  block(@Param('userId') userId: string) {
    return this.social.block(userId);
  }

  @Post('internal/reseed')
  reseed(@Body() _body: unknown) {
    return { ok: true };
  }
}
