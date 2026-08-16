import { Module } from '@nestjs/common';
import { realmUrls } from '@xitter/auth';
import { AuthModule } from '@xitter/auth-nest';
import { HealthModule } from '@xitter/health';
import { PrismaPg } from '@prisma/adapter-pg';
import { serviceDbUrl } from '@xitter/config';
import { env } from './env.js';
import { SearchModule } from './modules/search.module.js';
import { PrismaClient } from './generated/prisma/client.js';

@Module({
  imports: [
    AuthModule.forRoot({
      serviceName: 'search',
      issuer: realmUrls(env.KEYCLOAK_BASE_URL, env.DEMO_REALM).issuer,
      audience: 'svc-search',
      redisUrl: env.VALKEY_URL,
      trustEdgeHeaders: env.AUTH_TRUST_EDGE_HEADERS,
    }),
    SearchModule,
    HealthModule.forRoot({
      prismaFactory: () =>
        new PrismaClient({
          adapter: new PrismaPg({
            connectionString: process.env.DATABASE_URL ?? serviceDbUrl('search'),
          }),
        }),
    }),
  ],
})
export class AppModule {}
