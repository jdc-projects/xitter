import { Inject, Injectable, Module, OnApplicationShutdown, type Provider } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { createEventProducer } from '@xitter/events';
import { env } from '../../env.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { AdminController } from './admin.controller.js';
import { InternalController } from './internal.controller.js';
import { KafkaSocialEvents, SOCIAL_EVENTS, type SocialEvents } from './social-events.js';
import { SocialController } from './social.controller.js';
import { SOCIAL_PRISMA, SocialRepository, type SocialPrismaClient } from './social.repository.js';
import { SocialService } from './social.service.js';

const prismaProvider: Provider = {
  provide: SOCIAL_PRISMA,
  useFactory: (): SocialPrismaClient =>
    new PrismaClient({
      adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
    }),
};

const eventsProvider: Provider = {
  provide: SOCIAL_EVENTS,
  useFactory: (): SocialEvents =>
    new KafkaSocialEvents(
      createEventProducer({
        clientId: 'social',
        brokers: env.KAFKA_BROKERS.split(',').map((broker: string) => broker.trim()),
      }),
      'social',
    ),
};

/** Disconnect order: stop emitting, then close the DB pool. */
@Injectable()
export class SocialLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(SOCIAL_PRISMA) private readonly db: SocialPrismaClient,
    @Inject(SOCIAL_EVENTS) private readonly events: SocialEvents,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.events.shutdown().catch(() => undefined);
    await this.db.$disconnect().catch(() => undefined);
  }
}

@Module({
  controllers: [SocialController, InternalController, AdminController],
  providers: [prismaProvider, eventsProvider, SocialRepository, SocialService, SocialLifecycle],
})
export class SocialModule {}
