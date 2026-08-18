import { Inject, Injectable, Module, OnApplicationShutdown, type Provider } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { createEventProducer } from '@xitter/events';
import { env } from '../env.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { InternalController } from './internal.controller.js';
import { KafkaMediaEvents, MEDIA_EVENTS, type MediaEvents } from './media-events.js';
import { MediaController } from './media.controller.js';
import { MEDIA_PRISMA, MediaRepository, type MediaPrismaClient } from './media.repository.js';
import { MediaService } from './media.service.js';
import { MEDIA_STORAGE, RustFsStorage, type MediaStorage } from './storage.js';

const prismaProvider: Provider = {
  provide: MEDIA_PRISMA,
  useFactory: (): MediaPrismaClient =>
    new PrismaClient({
      adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
    }),
};

const eventsProvider: Provider = {
  provide: MEDIA_EVENTS,
  useFactory: (): MediaEvents =>
    new KafkaMediaEvents(
      createEventProducer({
        clientId: 'media',
        brokers: env.KAFKA_BROKERS.split(',').map((broker: string) => broker.trim()),
      }),
      'media',
    ),
};

const storageProvider: Provider = {
  provide: MEDIA_STORAGE,
  useFactory: (): MediaStorage =>
    new RustFsStorage({
      endpoint: env.XITTER_MEDIA_S3_ENDPOINT,
      publicEndpoint: env.XITTER_MEDIA_S3_PUBLIC_ENDPOINT,
      region: 'us-east-1',
      bucket: env.XITTER_MEDIA_S3_BUCKET,
      accessKeyId: env.XITTER_MEDIA_S3_ACCESS_KEY,
      secretAccessKey: env.XITTER_MEDIA_S3_SECRET_KEY,
    }),
};

/** Disconnect order: stop emitting, then close the DB pool. */
@Injectable()
export class MediaLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(MEDIA_PRISMA) private readonly db: MediaPrismaClient,
    @Inject(MEDIA_EVENTS) private readonly events: MediaEvents,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.events.shutdown().catch(() => undefined);
    await this.db.$disconnect().catch(() => undefined);
  }
}

@Module({
  controllers: [MediaController, InternalController],
  providers: [prismaProvider, eventsProvider, storageProvider, MediaRepository, MediaService, MediaLifecycle],
})
export class MediaModule {}
