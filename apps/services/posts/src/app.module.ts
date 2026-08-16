import { Module } from '@nestjs/common';
import { realmUrls } from '@xitter/auth';
import { AuthModule } from '@xitter/auth-nest';
import { env } from './env.js';
import { PostsModule } from './modules/posts.module.js';

@Module({
  imports: [
    AuthModule.forRoot({
      serviceName: 'posts',
      issuer: realmUrls(env.KEYCLOAK_BASE_URL, env.DEMO_REALM).issuer,
      audience: 'svc-posts',
      redisUrl: env.VALKEY_URL,
      trustEdgeHeaders: env.AUTH_TRUST_EDGE_HEADERS,
    }),
    PostsModule,
  ],
})
export class AppModule {}
