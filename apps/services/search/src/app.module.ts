import { Module } from '@nestjs/common';
import { realmUrls } from '@xitter/auth';
import { AuthModule } from '@xitter/auth-nest';
import { env } from './env.js';
import { SearchModule } from './modules/search.module.js';

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
  ],
})
export class AppModule {}
