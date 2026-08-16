import { Module } from '@nestjs/common';
import { realmUrls } from '@xitter/auth';
import { AuthModule } from '@xitter/auth-nest';
import { env } from './env.js';
import { MediaModule } from './modules/media.module.js';

@Module({
  imports: [
    AuthModule.forRoot({
      serviceName: 'media',
      issuer: realmUrls(env.KEYCLOAK_BASE_URL, env.DEMO_REALM).issuer,
      audience: 'svc-media',
      redisUrl: env.VALKEY_URL,
      trustEdgeHeaders: env.AUTH_TRUST_EDGE_HEADERS,
    }),
    MediaModule,
  ],
})
export class AppModule {}
