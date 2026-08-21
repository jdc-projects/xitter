import { Inject, Injectable, Module, OnApplicationShutdown, type Provider } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { realmUrls } from '@xitter/auth';
import { env } from '../env.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { CONTENT_HYDRATOR, ServiceContentHydrator } from './content-hydrator.js';
import { FEED_REALTIME, ValkeyFeedRealtime, type FeedRealtime } from './feed-realtime.js';
import { FeedController } from './feed.controller.js';
import { FEED_PRISMA, FeedRepository, type FeedPrismaClient } from './feed.repository.js';
import { FeedService } from './feed.service.js';
import { InternalFeedController } from './internal-feed.controller.js';
import { RESET_STATUS, ValkeyResetStatus, type ResetStatusReader } from './reset-status.js';

const prismaProvider: Provider = {
  provide: FEED_PRISMA,
  useFactory: (): FeedPrismaClient =>
    new PrismaClient({
      adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
    }),
};

// Hydration calls posts/social internal endpoints with feed's
// client-credentials token (audience svc-posts / svc-social).
const hydratorProvider: Provider = {
  provide: CONTENT_HYDRATOR,
  useFactory: () =>
    new ServiceContentHydrator({
      postsUrl: env.XITTER_POSTS_URL,
      socialUrl: env.XITTER_SOCIAL_URL,
      tokenUrl: realmUrls(env.KEYCLOAK_BASE_URL, env.DEMO_REALM).token,
      clientId: env.KEYCLOAK_CLIENT_ID,
      clientSecret: env.KEYCLOAK_CLIENT_SECRET,
    }),
};

const realtimeProvider: Provider = {
  provide: FEED_REALTIME,
  useFactory: () => new ValkeyFeedRealtime(env.VALKEY_URL),
};

const resetStatusProvider: Provider = {
  provide: RESET_STATUS,
  useFactory: () => new ValkeyResetStatus(env.VALKEY_URL),
};

/** Disconnect order: stop notifications, then close the DB pool. */
@Injectable()
export class FeedLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(FEED_PRISMA) private readonly db: FeedPrismaClient,
    @Inject(FEED_REALTIME) private readonly realtime: FeedRealtime,
    @Inject(RESET_STATUS) private readonly resetStatus: ResetStatusReader,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.realtime.stop?.().catch(() => undefined);
    await this.resetStatus.stop().catch(() => undefined);
    await this.db.$disconnect().catch(() => undefined);
  }
}

@Module({
  controllers: [FeedController, InternalFeedController],
  providers: [
    prismaProvider,
    hydratorProvider,
    realtimeProvider,
    resetStatusProvider,
    FeedRepository,
    FeedService,
    FeedLifecycle,
  ],
})
export class FeedModule {}
