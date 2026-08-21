import { Module } from '@nestjs/common';
import { realmUrls } from '@xitter/auth';
import { AuthModule } from '@xitter/auth-nest';
import { HealthModule } from '@xitter/health';
import { PrismaPg } from '@prisma/adapter-pg';
import { serviceDbUrl } from '@xitter/config';
import { env } from './env.js';
import { SocialModule } from './modules/social/social.module.js';
import { PrismaClient } from './generated/prisma/client.js';

@Module({
  imports: [
    AuthModule.forRoot({
      serviceName: 'social',
      issuer: realmUrls(env.KEYCLOAK_BASE_URL, env.DEMO_REALM).issuer,
      audience: 'svc-social',
      redisUrl: env.VALKEY_URL,
      trustEdgeHeaders: env.AUTH_TRUST_EDGE_HEADERS,
      adminIssuer: realmUrls(env.KEYCLOAK_BASE_URL, env.ADMIN_REALM).issuer,
    }),
    SocialModule,
    HealthModule.forRoot({
      serviceName: 'social',
      prismaFactory: () =>
        new PrismaClient({
          adapter: new PrismaPg({
            connectionString: process.env.DATABASE_URL ?? serviceDbUrl('social'),
          }),
        }),
    }),
  ],
})
export class AppModule {}
