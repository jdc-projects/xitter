import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { TokenVerifier } from '@xitter/auth';
import {
  AUTH_OPTIONS,
  ADMIN_VERIFIER,
  AuthGuard,
  ErrorEnvelopeFilter,
  SERVICE_VERIFIER,
  USER_VERIFIER,
} from '@xitter/auth-nest';
import type { ResetStatus } from '@xitter/api-contracts';
import { AdminFeedController } from './admin-feed.controller.js';
import { RESET_STATUS, type ResetStatusReader } from './reset-status.js';

/**
 * HTTP wiring for the panel's reset-status route: it sits at
 * /api/feed/internal/admin/reset-status (no version segment), admits the
 * admin principal the panel holds, rejects everything else, and returns the
 * reader's record verbatim. The real AuthGuard runs with stub verifiers -
 * token crypto is @xitter/auth-nest's own test surface, but the route's
 * gating decision is feed-owned wiring.
 */

const record: ResetStatus = {
  job: 'xitter-reset',
  startedAt: '2026-08-30T00:30:00.000Z',
  finishedAt: '2026-08-30T00:30:42.000Z',
  durationMs: 42_000,
  success: true,
  reseeded: true,
  fingerprint: 'b'.repeat(64),
  steps: [],
};

const verifierFor = (
  tokens: Record<string, { roles: string[]; azp: string; subject: string }>,
): TokenVerifier => ({
  async verify(token: string) {
    const token_ = tokens[token];
    if (!token_) throw new Error('unknown token');
    return {
      subject: token_.subject,
      username: token_.azp,
      roles: token_.roles,
      audience: 'svc-feed',
      claims: { azp: token_.azp },
    };
  },
});

/** The panel's principal: an admin-realm user token (azp = admin-panel). */
const adminUserVerifier = verifierFor({
  'admin-user-token': { roles: ['system-admin'], azp: 'admin-panel', subject: 'admin-1' },
});

/** Machine principals: svc-admin carries the role, plain services do not. */
const serviceVerifier = verifierFor({
  'svc-admin-token': { roles: ['system-admin'], azp: 'svc-admin', subject: 'svc-admin' },
  'svc-plain-token': { roles: [], azp: 'svc-reset', subject: 'svc-reset' },
});

const rejectAll: TokenVerifier = {
  async verify() {
    throw new Error('no token model for this route');
  },
};

async function createApp(reader: ResetStatusReader): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [AdminFeedController],
    providers: [
      { provide: RESET_STATUS, useValue: reader },
      {
        provide: AUTH_OPTIONS,
        useValue: {
          serviceName: 'feed',
          issuer: 'http://kc/realms/xitter-demo',
          audience: 'svc-feed',
          adminIssuer: 'http://kc/realms/xitter-local-admin',
          adminClients: ['admin-panel'],
        },
      },
      { provide: USER_VERIFIER, useValue: rejectAll },
      { provide: SERVICE_VERIFIER, useValue: serviceVerifier },
      { provide: ADMIN_VERIFIER, useValue: adminUserVerifier },
      AuthGuard,
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  // Mirrors bootstrapApiService: internal routes sit outside the versioned
  // prefix, the global AuthGuard owns gating, errors use the shared envelope.
  app.setGlobalPrefix('api/feed', { exclude: ['healthz', 'readyz'] });
  app.useGlobalGuards(app.get(AuthGuard));
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  await app.init();
  return app;
}

const readerOver = (latest: ResetStatus | null): ResetStatusReader => ({
  latest: () => Promise.resolve(latest),
  stop: () => Promise.resolve(),
});

describe('AdminFeedController (reset-status for the panel)', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('serves the reader record to the admin-realm principal', async () => {
    app = await createApp(readerOver(record));

    const res = await app.inject({
      method: 'GET',
      url: '/api/feed/internal/admin/reset-status',
      headers: { authorization: 'Bearer admin-user-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(record);
  });

  it('also admits the svc-admin machine principal', async () => {
    app = await createApp(readerOver(record));

    const res = await app.inject({
      method: 'GET',
      url: '/api/feed/internal/admin/reset-status',
      headers: { authorization: 'Bearer svc-admin-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(record);
  });

  it('answers 200 with null when no reset has run (empty state, not an error)', async () => {
    app = await createApp(readerOver(null));

    const res = await app.inject({
      method: 'GET',
      url: '/api/feed/internal/admin/reset-status',
      headers: { authorization: 'Bearer admin-user-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
  });

  it('rejects a missing token with the 401 envelope', async () => {
    app = await createApp(readerOver(record));

    const res = await app.inject({ method: 'GET', url: '/api/feed/internal/admin/reset-status' });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('rejects a plain service token without the admin role with 403', async () => {
    app = await createApp(readerOver(record));

    const res = await app.inject({
      method: 'GET',
      url: '/api/feed/internal/admin/reset-status',
      headers: { authorization: 'Bearer svc-plain-token' },
    });

    // Bad credential vs missing grant: operators can tell them apart.
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('sits outside the versioned prefix (spec 03)', async () => {
    app = await createApp(readerOver(record));

    const res = await app.inject({
      method: 'GET',
      url: '/api/feed/v1/internal/admin/reset-status',
      headers: { authorization: 'Bearer admin-user-token' },
    });

    expect(res.statusCode).toBe(404);
  });
});
