import { Injectable } from "@nestjs/common";

/**
 * Profiles, follows, and blocks.
 *
 * Skeleton: Prisma persistence, follow/block rules, Kafka events, and
 * relationship view models land with the social feature ticket - the contract
 * is documented in docs/specs/architecture/03-service-interfaces.md.
 */
@Injectable()
export class SocialService {
  follow(userId: string): { followed: string } {
    return { followed: userId };
  }

  block(userId: string): { blocked: string } {
    return { blocked: userId };
  }
}
