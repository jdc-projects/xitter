import { Module } from '@nestjs/common';
import { realmUrls } from '@xitter/auth';
import { AuthModule } from '@xitter/auth-nest';
import { HealthModule } from '@xitter/health';
import { PrismaPg } from '@prisma/adapter-pg';
import { serviceDbUrl } from '@xitter/config';
import { env } from './env.js';
import { FeedModule } from './modules/feed.module.js';
import { PrismaClient } from './generated/prisma/client.js';

@Module({
  imports: [
    AuthModule.forRoot({
      serviceName: 'feed',
      issuer: realmUrls(env.KEYCLOAK_BASE_URL, env.DEMO_REALM).issuer,
      audience: 'svc-feed',
      redisUrl: env.VALKEY_URL,
      trustEdgeHeaders: env.AUTH_TRUST_EDGE_HEADERS,
      adminIssuer: realmUrls(env.KEYCLOAK_BASE_URL, env.ADMIN_REALM).issuer,
    }),
    FeedModule,
    HealthModule.forRoot({
      serviceName: 'feed',
      prismaFactory: () =>
        new PrismaClient({
          adapter: new PrismaPg({
            connectionString: process.env.DATABASE_URL ?? serviceDbUrl('feed'),
          }),
        }),
    }),
  ],
})
export class AppModule {}
