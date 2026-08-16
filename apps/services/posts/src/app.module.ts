import { Module } from '@nestjs/common';
import { HealthModule } from '@xitter/health';
import { PrismaPg } from '@prisma/adapter-pg';
import { serviceDbUrl } from '@xitter/config';
import { PostsModule } from './modules/posts.module.js';
import { PrismaClient } from './generated/prisma/client.js';

@Module({
  imports: [
    PostsModule,
    HealthModule.forRoot({
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
