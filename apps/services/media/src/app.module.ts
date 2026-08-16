import { Module } from '@nestjs/common';
import { HealthModule } from '@xitter/health';
import { PrismaPg } from '@prisma/adapter-pg';
import { serviceDbUrl } from '@xitter/config';
import { MediaModule } from './modules/media.module.js';
import { PrismaClient } from './generated/prisma/client.js';

@Module({
  imports: [
    MediaModule,
    HealthModule.forRoot({
      prismaFactory: () =>
        new PrismaClient({
          adapter: new PrismaPg({
            connectionString: process.env.DATABASE_URL ?? serviceDbUrl('media'),
          }),
        }),
    }),
  ],
})
export class AppModule {}
