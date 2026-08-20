import { Inject, Injectable, Module, OnApplicationShutdown, type Provider } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { realmUrls } from '@xitter/auth';
import { createEventProducer } from '@xitter/events';
import { env } from '../env.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { AdminController } from './admin.controller.js';
import { InternalController } from './internal.controller.js';
import { MEDIA_CHECKER, MediaServiceChecker, type MediaChecker } from './media-checker.js';
import { KafkaPostsEvents, POSTS_EVENTS, type PostsEvents } from './posts-events.js';
import { PostsController } from './posts.controller.js';
import { POSTS_PRISMA, PostsRepository, type PostsPrismaClient } from './posts.repository.js';
import { PostsService } from './posts.service.js';
import {
  RELATIONSHIP_CHECKER,
  SocialRelationshipChecker,
  type RelationshipChecker,
} from './relationship-checker.js';

const prismaProvider: Provider = {
  provide: POSTS_PRISMA,
  useFactory: (): PostsPrismaClient =>
    new PrismaClient({
      adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
    }),
};

const eventsProvider: Provider = {
  provide: POSTS_EVENTS,
  useFactory: (): PostsEvents =>
    new KafkaPostsEvents(
      createEventProducer({
        clientId: 'posts',
        brokers: env.KAFKA_BROKERS.split(',').map((broker: string) => broker.trim()),
      }),
      'posts',
    ),
};

const relationshipCheckerProvider: Provider = {
  provide: RELATIONSHIP_CHECKER,
  useFactory: (): RelationshipChecker =>
    new SocialRelationshipChecker({
      baseUrl: env.XITTER_SOCIAL_URL,
      tokenUrl: realmUrls(env.KEYCLOAK_BASE_URL, env.DEMO_REALM).token,
      clientId: env.KEYCLOAK_CLIENT_ID,
      clientSecret: env.KEYCLOAK_CLIENT_SECRET,
    }),
};

const mediaCheckerProvider: Provider = {
  provide: MEDIA_CHECKER,
  useFactory: (): MediaChecker =>
    new MediaServiceChecker({
      baseUrl: env.XITTER_MEDIA_URL,
      tokenUrl: realmUrls(env.KEYCLOAK_BASE_URL, env.DEMO_REALM).token,
      clientId: env.KEYCLOAK_CLIENT_ID,
      clientSecret: env.KEYCLOAK_CLIENT_SECRET,
    }),
};

/** Disconnect order: stop emitting, then close the DB pool. */
@Injectable()
export class PostsLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(POSTS_PRISMA) private readonly db: PostsPrismaClient,
    @Inject(POSTS_EVENTS) private readonly events: PostsEvents,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.events.shutdown().catch(() => undefined);
    await this.db.$disconnect().catch(() => undefined);
  }
}

@Module({
  controllers: [PostsController, InternalController, AdminController],
  providers: [
    prismaProvider,
    eventsProvider,
    relationshipCheckerProvider,
    mediaCheckerProvider,
    PostsRepository,
    PostsService,
    PostsLifecycle,
  ],
})
export class PostsModule {}
