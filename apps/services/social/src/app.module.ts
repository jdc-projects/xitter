import { Module } from '@nestjs/common';
import { HealthModule } from '@xitter/health';
import { PrismaPg } from '@prisma/adapter-pg';
import { serviceDbUrl } from '@xitter/config';
import { SocialModule } from './modules/social/social.module.js';
import { PrismaClient } from './generated/prisma/client.js';

@Module({
  imports: [
    SocialModule,
    HealthModule.forRoot({
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
