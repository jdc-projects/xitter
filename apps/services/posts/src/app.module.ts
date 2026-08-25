import { Module } from '@nestjs/common';
import { realmUrls } from '@xitter/auth';
import { AuthModule } from '@xitter/auth-nest';
import { HealthModule } from '@xitter/health';
import { PrismaPg } from '@prisma/adapter-pg';
import { serviceDbUrl } from '@xitter/config';
import { env } from './env.js';
import { PostsModule } from './modules/posts.module.js';
import { PrismaClient } from './generated/prisma/client.js';

@Module({
  imports: [
    AuthModule.forRoot({
      serviceName: 'posts',
      // Issuer MUST be the realm's canonical (frontend) URL - what
      // Keycloak stamps into `iss` regardless of the transport that served
      // the grant. The transport (KEYCLOAK_BASE_URL) still carries JWKS.
      issuer: env.KEYCLOAK_ISSUER ?? realmUrls(env.KEYCLOAK_BASE_URL, env.DEMO_REALM).issuer,
      jwksUri: realmUrls(env.KEYCLOAK_BASE_URL, env.DEMO_REALM).jwks,
      audience: 'svc-posts',
      redisUrl: env.VALKEY_URL,
      trustEdgeHeaders: env.AUTH_TRUST_EDGE_HEADERS,
      adminIssuer: realmUrls(env.KEYCLOAK_BASE_URL, env.ADMIN_REALM).issuer,
      adminJwksUri: realmUrls(env.KEYCLOAK_BASE_URL, env.ADMIN_REALM).jwks,
    }),
    PostsModule,
    HealthModule.forRoot({
      serviceName: 'posts',
      prismaFactory: () =>
        new PrismaClient({
          adapter: new PrismaPg({
            connectionString: process.env.DATABASE_URL ?? serviceDbUrl('posts'),
          }),
        }),
    }),
  ],
})
export class AppModule {}
