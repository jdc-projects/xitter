import { CanActivate, Controller, Get, type ExecutionContext } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ErrorEnvelopeFilter, RateLimitGuard } from '@xitter/auth-nest';
import { afterEach, describe, expect, it } from 'vitest';
import type { MediaAsset } from '@xitter/api-contracts';
import { InternalController } from './internal.controller.js';
import { MEDIA_EVENTS, NullMediaEvents } from './media-events.js';
import { MediaController } from './media.controller.js';
import { MediaRepository, type MediaRow } from './media.repository.js';
import { MediaService } from './media.service.js';
import { MEDIA_STORAGE, type MediaStorage } from './storage.js';

/**
 * HTTP wiring: versioned public prefix, internal routes OUTSIDE it (spec 03),
 * zod validation -> error envelope, 415/413 limit codes. The global
 * AuthGuard is stood in for by a stub principal (token validation is
 * @xitter/auth-nest's own test surface).
 */

const CALLER = '00000000-0000-4000-8000-0000000000c1';
const MEDIA_ID = '00000000-0000-4000-8000-0000000000d1';
/** An id no row exists for (mid-processing wipe / moderation delete / typo). */
const MISSING_ID = '00000000-0000-4000-8000-0000000000d2';

@Controller('placeholder')
class PlaceholderController {
  @Get()
  find() {
    return { ok: true };
  }
}

/** Stub global guard: every request is CALLER. */
const stubAuthGuard: CanActivate = {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest<{ user?: unknown }>().user = {
      subject: CALLER,
      username: 'democaller',
      roles: [],
      service: false,
    };
    return true;
  },
};

const row = (overrides: Partial<MediaRow> = {}): MediaRow => ({
  id: MEDIA_ID,
  ownerId: CALLER,
  status: 'pending',
  objectKey: `${CALLER}/${MEDIA_ID}/original.png`,
  mimeType: 'image/png',
  bytes: 1024,
  variants: [],
  attempts: 0,
  uploadedAt: null,
  createdAt: new Date('2026-08-18T00:00:00Z'),
  ...overrides,
});

const repoStub = {
  find: (id: string) => Promise.resolve(id === MISSING_ID ? null : row()),
  findByIds: () => Promise.resolve([row()]),
  create: () => Promise.resolve(row({ id: '00000000-0000-4000-8000-0000000000e1' })),
  markUploaded: () => Promise.resolve(row({ uploadedAt: new Date() })),
  markFailed: () => Promise.resolve(row({ status: 'failed' })),
  recordVariants: () => Promise.resolve(row({ status: 'ready' })),
  recordAttempt: () => Promise.resolve(row({ attempts: 1 })),
  truncate: () => Promise.resolve(0),
} as unknown as MediaRepository;

const storageStub: MediaStorage = {
  presignPut: (objectKey) => Promise.resolve(`http://rustfs.test/${objectKey}?sig`),
  head: () => Promise.resolve({ bytes: 2048, contentType: 'image/png' }),
  get: () => Promise.resolve(new Uint8Array()),
  put: () => Promise.resolve(),
  remove: () => Promise.resolve(),
};

async function createApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [MediaController, InternalController, PlaceholderController],
    providers: [
      { provide: MediaRepository, useValue: repoStub },
      { provide: MEDIA_EVENTS, useValue: new NullMediaEvents() },
      { provide: MEDIA_STORAGE, useValue: storageStub },
      MediaService,
    ],
  })
    .overrideGuard(RateLimitGuard)
    .useValue({ canActivate: () => true })
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalGuards(stubAuthGuard);
  // Exactly like main.ts: service-level prefix, `v1` on the public
  // controller, `internal` without a version.
  app.setGlobalPrefix('api/media');
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  await app.init();
  return app;
}

describe('media HTTP wiring', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('creates upload slots under the versioned prefix', async () => {
    app = await createApp();

    const created = await app.inject({
      method: 'POST',
      url: '/api/media/v1/uploads',
      payload: { mimeType: 'image/png', bytes: 2048 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      mediaId: expect.any(String),
      uploadUrl: expect.stringContaining('http://rustfs.test/'),
    });
  });

  it('surfaces limit decisions as 415 (type) and 413 (size), 400 for shape', async () => {
    app = await createApp();

    const wrongType = await app.inject({
      method: 'POST',
      url: '/api/media/v1/uploads',
      payload: { mimeType: 'image/heic', bytes: 10 },
    });
    expect(wrongType.statusCode).toBe(415);
    expect(wrongType.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });

    const tooBig = await app.inject({
      method: 'POST',
      url: '/api/media/v1/uploads',
      payload: { mimeType: 'image/png', bytes: 5 * 1024 * 1024 + 1 },
    });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });

    const badShape = await app.inject({
      method: 'POST',
      url: '/api/media/v1/uploads',
      payload: { mimeType: 'image/png', bytes: -1 },
    });
    expect(badShape.statusCode).toBe(400);
  });

  it('completes uploads with 200 (not the pipe-default 201)', async () => {
    app = await createApp();

    const completed = await app.inject({
      method: 'POST',
      url: `/api/media/v1/media/${MEDIA_ID}/complete`,
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ id: MEDIA_ID, status: 'pending' });

    const badParam = await app.inject({
      method: 'POST',
      url: '/api/media/v1/media/not-a-uuid/complete',
    });
    expect(badParam.statusCode).toBe(400);
  });

  it('serves media metadata with variant urls', async () => {
    app = await createApp();

    const found = await app.inject({ method: 'GET', url: `/api/media/v1/media/${MEDIA_ID}` });
    expect(found.statusCode).toBe(200);
    const asset = found.json() as MediaAsset;
    expect(asset.id).toBe(MEDIA_ID);
    expect(asset.variants).toEqual([]);
  });

  it('polling an absent asset 404s with the standard envelope', async () => {
    app = await createApp();

    const missing = await app.inject({ method: 'GET', url: `/api/media/v1/media/${MISSING_ID}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('serves internal endpoints outside the versioned prefix', async () => {
    app = await createApp();

    const lookup = await app.inject({
      method: 'POST',
      url: '/api/media/internal/media/lookup',
      payload: { ownerId: CALLER, mediaIds: [MEDIA_ID] },
    });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toMatchObject({ items: [{ id: MEDIA_ID }] });

    const variants = await app.inject({
      method: 'POST',
      url: `/api/media/internal/media/${MEDIA_ID}/variants`,
      payload: {
        variants: [
          {
            kind: 'original',
            objectKey: `${CALLER}/${MEDIA_ID}/original.png`,
            mimeType: 'image/png',
            bytes: 1024,
            width: 64,
            height: 32,
          },
        ],
      },
    });
    expect(variants.statusCode).toBe(200);
    expect(variants.json()).toMatchObject({ status: 'ready' });

    const reseed = await app.inject({ method: 'POST', url: '/api/media/internal/reseed' });
    expect(reseed.statusCode).toBe(200);
    expect(reseed.json()).toEqual({ ok: true });

    const versioned = await app.inject({
      method: 'POST',
      url: '/api/media/v1/internal/reseed',
    });
    expect(versioned.statusCode).toBe(404);
  });
});
