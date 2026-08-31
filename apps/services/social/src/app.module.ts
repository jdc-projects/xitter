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
      // Issuer MUST be the realm's canonical (frontend) URL - what
      // Keycloak stamps into `iss` regardless of the transport that served
      // the grant. The transport (KEYCLOAK_BASE_URL) still carries JWKS.
      issuer: env.KEYCLOAK_ISSUER ?? realmUrls(env.KEYCLOAK_BASE_URL, env.DEMO_REALM).issuer,
      jwksUri: realmUrls(env.KEYCLOAK_BASE_URL, env.DEMO_REALM).jwks,
      audience: 'svc-social',
      redisUrl: env.VALKEY_URL,
      trustEdgeHeaders: env.AUTH_TRUST_EDGE_HEADERS,
      // Public admin issuer when transport is in-cluster (see service-env).
      adminIssuer: env.ADMIN_ISSUER ?? realmUrls(env.KEYCLOAK_BASE_URL, env.ADMIN_REALM).issuer,
      adminJwksUri: realmUrls(env.KEYCLOAK_BASE_URL, env.ADMIN_REALM).jwks,
      // azp allowlist for the human admin path (deployed: the env's admin SPA).
      adminClients: env.ADMIN_CLIENTS.split(',').map((c) => c.trim()),
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
