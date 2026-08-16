import { CanActivate, Controller, Get, type ExecutionContext } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ErrorEnvelopeFilter, RateLimitGuard } from '@xitter/auth-nest';
import { afterEach, describe, expect, it } from 'vitest';
import { InternalController } from './internal.controller.js';
import { SOCIAL_EVENTS, NullSocialEvents } from './social-events.js';
import { SocialController } from './social.controller.js';
import { SocialRepository } from './social.repository.js';
import { SocialService } from './social.service.js';

/**
 * HTTP wiring: versioned public prefix, internal routes OUTSIDE it (spec 03),
 * zod validation -> error envelope, 204 mutations. The global AuthGuard is
 * stood in for by a stub principal (token validation is @xitter/auth-nest's
 * own test surface).
 */

const CALLER = '00000000-0000-4000-8000-0000000000c1';
const OTHER = '00000000-0000-4000-8000-0000000000c2';

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

const profileRow = (id: string, username: string) => ({
  id,
  username,
  displayName: `Display ${username}`,
  bio: null,
  createdAt: new Date('2026-08-16T00:00:00Z'),
});

const repoStub = {
  findProfile: (id: string) =>
    Promise.resolve(profileRow(id, id === CALLER ? 'democaller' : 'otheruser')),
  findProfileByUsername: (username: string) =>
    Promise.resolve(username === 'otheruser' ? profileRow(OTHER, 'otheruser') : null),
  createProfile: (data: {
    id: string;
    username: string;
    displayName: string;
    bio: string | null;
  }) => Promise.resolve({ createdAt: new Date(), ...data }),
  updateProfile: (id: string, data: { displayName?: string; bio?: string | null }) =>
    Promise.resolve({ ...profileRow(id, 'democaller'), ...data }),
  findFollow: () => Promise.resolve(null),
  createFollow: () => Promise.resolve(true),
  deleteFollow: () => Promise.resolve(true),
  findBlock: () => Promise.resolve(null),
  createBlock: () => Promise.resolve(true),
  deleteBlock: () => Promise.resolve(true),
  deleteFollowsBetween: () => Promise.resolve(0),
  counts: () => Promise.resolve({ following: 0, followers: 0 }),
  followPage: () => Promise.resolve({ items: [profileRow(OTHER, 'otheruser')], nextCursor: null }),
  followerIds: () => Promise.resolve([OTHER]),
  blockedIds: () => Promise.resolve([]),
  truncate: () => Promise.resolve(),
  toProfile: (row: ReturnType<typeof profileRow>) => ({
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    bio: row.bio,
    createdAt: row.createdAt.toISOString(),
  }),
} as unknown as SocialRepository;

async function createApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [SocialController, InternalController, PlaceholderController],
    providers: [
      { provide: SocialRepository, useValue: repoStub },
      { provide: SOCIAL_EVENTS, useValue: new NullSocialEvents() },
      SocialService,
    ],
  })
    .overrideGuard(RateLimitGuard)
    .useValue({ canActivate: () => true })
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalGuards(stubAuthGuard);
  // Exactly like main.ts: service-level prefix, `v1` on the public
  // controller, `internal` without a version.
  app.setGlobalPrefix('api/social');
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  await app.init();
  return app;
}

describe('social HTTP wiring', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('serves profile creation under the versioned prefix with validation envelopes', async () => {
    app = await createApp();

    const created = await app.inject({
      method: 'POST',
      url: `/api/social/v1/profiles/${CALLER}`,
      payload: { displayName: 'Demo Caller' },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ id: CALLER, username: 'democaller' });

    const invalid = await app.inject({
      method: 'POST',
      url: `/api/social/v1/profiles/${CALLER}`,
      payload: { displayName: '' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('returns 204 from follow/unfollow/block/unblock', async () => {
    app = await createApp();

    for (const [method, suffix] of [
      ['post', 'follow'],
      ['delete', 'follow'],
      ['post', 'block'],
      ['delete', 'block'],
    ] as const) {
      const res = await app.inject({ method, url: `/api/social/v1/profiles/${OTHER}/${suffix}` });
      expect(res.statusCode, `${method} ${suffix}`).toBe(204);
    }
  });

  it('rejects invalid params with the error envelope', async () => {
    app = await createApp();

    const badUsername = await app.inject({
      method: 'GET',
      url: '/api/social/v1/profiles/username/Not_Valid!',
    });
    expect(badUsername.statusCode).toBe(400);
    expect(badUsername.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const badLimit = await app.inject({
      method: 'GET',
      url: `/api/social/v1/profiles/${OTHER}/following?limit=999`,
    });
    expect(badLimit.statusCode).toBe(400);
  });

  it('serves internal endpoints outside the versioned prefix', async () => {
    app = await createApp();

    const followers = await app.inject({
      method: 'GET',
      url: `/api/social/internal/users/${OTHER}/followers/ids`,
    });
    expect(followers.statusCode).toBe(200);
    expect(followers.json()).toEqual([OTHER]);

    const versioned = await app.inject({
      method: 'GET',
      url: `/api/social/v1/internal/users/${OTHER}/followers/ids`,
    });
    expect(versioned.statusCode).toBe(404);

    const pair = await app.inject({
      method: 'GET',
      url: `/api/social/internal/users/${OTHER}/relationships/${CALLER}`,
    });
    expect(pair.statusCode).toBe(200);
    expect(pair.json()).toMatchObject({ following: false, blocking: false });

    const blocked = await app.inject({
      method: 'GET',
      url: `/api/social/internal/users/${CALLER}/blocked/ids`,
    });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json()).toEqual([]);
  });

  it('serialises service errors through the error envelope', async () => {
    app = await createApp();

    const missing = await app.inject({
      method: 'GET',
      url: '/api/social/v1/profiles/username/nobody',
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Profile not found' } });
  });
});
