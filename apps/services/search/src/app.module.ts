import { Module } from '@nestjs/common';
import { HealthModule } from '@xitter/health';
import { PrismaPg } from '@prisma/adapter-pg';
import { serviceDbUrl } from '@xitter/config';
import { SearchModule } from './modules/search.module.js';
import { PrismaClient } from './generated/prisma/client.js';

@Module({
  imports: [
    SearchModule,
    HealthModule.forRoot({
      prismaFactory: () =>
        new PrismaClient({
          adapter: new PrismaPg({
            connectionString: process.env.DATABASE_URL ?? serviceDbUrl('search'),
          }),
        }),
    }),
  ],
})
export class AppModule {}
