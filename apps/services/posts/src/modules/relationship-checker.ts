import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { SocialClient } from '@xitter/api-client';
import { createLogger } from '@xitter/observability';

const logger = createLogger({ service: 'posts' });

/** Block-check seam: the service depends on this port, not on SocialClient. */
export interface RelationshipChecker {
  /** True when a block exists between the two users in either direction. */
  blockedEitherWay(viewerId: string, otherId: string): Promise<boolean>;
}

/** Injection token (string token so test doubles are easy to provide). */
export const RELATIONSHIP_CHECKER = 'RELATIONSHIP_CHECKER';

/** Inert checker for tests and contexts without a social dependency. */
export class NullRelationshipChecker implements RelationshipChecker {
  blockedEitherWay(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/**
 * Social-backed block check via its internal relationship endpoint (spec 03),
 * authenticated with this service's client-credentials token (audience
 * svc-social). Fails CLOSED: when social cannot answer, replies are rejected -
 * availability yields to the "blocked users cannot reply" guarantee.
 */
@Injectable()
export class SocialRelationshipChecker implements RelationshipChecker {
  private readonly social: SocialClient;

  constructor(options: {
    baseUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    fetchImpl?: typeof fetch;
  }) {
    this.social = new SocialClient({
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
      internal: {
        tokenUrl: options.tokenUrl,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
      },
    });
  }

  async blockedEitherWay(viewerId: string, otherId: string): Promise<boolean> {
    try {
      const relationship = await this.social.internalRelationship(viewerId, otherId);
      return relationship.blocking || relationship.blockedBy;
    } catch (err) {
      logger.error({ err }, 'social relationship check failed');
      throw new ServiceUnavailableException({
        error: {
          code: 'INTERNAL',
          message: 'Cannot verify reply permissions right now - try again shortly',
        },
      });
    }
  }
}
