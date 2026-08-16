import { Module } from '@nestjs/common';
import { realmUrls } from '@xitter/auth';
import { AuthModule } from '@xitter/auth-nest';
import { env } from './env.js';
import { FeedModule } from './modules/feed.module.js';

@Module({
  imports: [
    AuthModule.forRoot({
      serviceName: 'feed',
      issuer: realmUrls(env.KEYCLOAK_BASE_URL, env.DEMO_REALM).issuer,
      audience: 'svc-feed',
      redisUrl: env.VALKEY_URL,
      trustEdgeHeaders: env.AUTH_TRUST_EDGE_HEADERS,
    }),
    FeedModule,
  ],
})
export class AppModule {}
