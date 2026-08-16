import { Module } from '@nestjs/common';
import { realmUrls } from '@xitter/auth';
import { AuthModule } from '@xitter/auth-nest';
import { env } from './env.js';
import { SocialModule } from './modules/social/social.module.js';

@Module({
  imports: [
    AuthModule.forRoot({
      serviceName: 'social',
      issuer: realmUrls(env.KEYCLOAK_BASE_URL, env.DEMO_REALM).issuer,
      audience: 'svc-social',
      redisUrl: env.VALKEY_URL,
      trustEdgeHeaders: env.AUTH_TRUST_EDGE_HEADERS,
    }),
    SocialModule,
  ],
})
export class AppModule {}
