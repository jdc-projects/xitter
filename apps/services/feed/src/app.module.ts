import { Module } from '@nestjs/common';
import { HealthModule } from '@xitter/health';
import { PrismaPg } from '@prisma/adapter-pg';
import { serviceDbUrl } from '@xitter/config';
import { FeedModule } from './modules/feed.module.js';
import { PrismaClient } from './generated/prisma/client.js';

@Module({
  imports: [
    FeedModule,
    HealthModule.forRoot({
      prismaFactory: () =>
        new PrismaClient({
          adapter: new PrismaPg({
            connectionString: process.env.DATABASE_URL ?? serviceDbUrl('feed'),
          }),
        }),
    }),
  ],
})
export class AppModule {}
