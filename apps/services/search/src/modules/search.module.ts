import { Inject, Injectable, Module, OnApplicationShutdown, type Provider } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { realmUrls } from '@xitter/auth';
import { env } from '../env.js';
import { PrismaClient } from '../generated/prisma/client.js';
import {
  CheckpointRepository,
  SEARCH_PRISMA,
  type SearchPrismaClient,
} from './checkpoint.repository.js';
import { InternalSearchController } from './internal-search.controller.js';
import { createOpenSearchClient } from './opensearch-client.js';
import { OPENSEARCH, PostsIndex } from './posts-index.js';
import { SEARCH_CONTENT, ServiceSearchContent } from './search-content.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';

const prismaProvider: Provider = {
  provide: SEARCH_PRISMA,
  useFactory: (): SearchPrismaClient =>
    new PrismaClient({
      adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
    }),
};

const opensearchProvider: Provider = {
  provide: OPENSEARCH,
  useFactory: () => createOpenSearchClient(env.XITTER_OPENSEARCH_URL),
};

// Hydration calls posts/social internal endpoints with search's
// client-credentials token (audience svc-posts / svc-social).
const contentProvider: Provider = {
  provide: SEARCH_CONTENT,
  useFactory: () =>
    new ServiceSearchContent({
      postsUrl: env.XITTER_POSTS_URL,
      socialUrl: env.XITTER_SOCIAL_URL,
      tokenUrl: realmUrls(env.KEYCLOAK_BASE_URL, env.DEMO_REALM).token,
      clientId: env.KEYCLOAK_CLIENT_ID,
      clientSecret: env.KEYCLOAK_CLIENT_SECRET,
    }),
};

/** Disconnect order: close the OpenSearch transport, then the DB pool. */
@Injectable()
export class SearchLifecycle implements OnApplicationShutdown {
  constructor(
    private readonly index: PostsIndex,
    @Inject(SEARCH_PRISMA) private readonly db: SearchPrismaClient,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.index.close().catch(() => undefined);
    await this.db.$disconnect().catch(() => undefined);
  }
}

@Module({
  controllers: [SearchController, InternalSearchController],
  providers: [
    prismaProvider,
    opensearchProvider,
    contentProvider,
    PostsIndex,
    CheckpointRepository,
    SearchService,
    SearchLifecycle,
  ],
})
export class SearchModule {}
