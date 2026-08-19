import { Controller, Get } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { HEALTH_DB, HealthModule, type HealthCheckedDb } from '@xitter/health';

// Deliberately does NOT import AppModule: that drags in the generated Prisma
// client (src/generated/prisma), which is gitignored and so never reaches
// Stryker's sandbox. HealthModule.forRoot() - the wiring under test - is the
// real thing; a placeholder controller stands in for the service's API routes
// so the global prefix has something to exclude the probes against.
@Controller('placeholder')
class PlaceholderController {
  @Get()
  find() {
    return { ok: true };
  }
}

// Stands in for the internal controller so the prefix test can prove
// internal routes land OUTSIDE the versioned prefix (the v1-must-not-
// prefix-internal bug class this service shipped and fixed once already).
@Controller('internal/feed')
class PlaceholderInternalController {
  @Get()
  find() {
    return { ok: true };
  }
}

const healthyDb: HealthCheckedDb = {
  $queryRawUnsafe: () => Promise.resolve(1),
  $disconnect: () => Promise.resolve(undefined),
};

async function createApp(dbOverride?: object): Promise<NestFastifyApplication> {
  const builder = Test.createTestingModule({
    imports: [HealthModule.forRoot({ prismaFactory: () => healthyDb })],
    controllers: [PlaceholderController, PlaceholderInternalController],
  });
  if (dbOverride) builder.overrideProvider(HEALTH_DB).useValue(dbOverride);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  // Mirrors main.ts: internal routes sit at /api/feed/internal/... without a
  // version segment (spec 03) - the placeholder controller stands in for
  // them so the prefix wiring has something to assert against. Only this
  // prefix wiring is replicated here - main.ts's bootstrap config (env
  // parsing, tracing, Sentry) isn't unit-testable.
  app.setGlobalPrefix('api/feed', { exclude: ['healthz', 'readyz'] });
  await app.init();
  return app;
}

describe('health probe wiring', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('serves liveness at the root, outside the api/feed/v1 prefix', async () => {
    app = await createApp();

    const res = await app.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('fails readiness with 503 when the database is down', async () => {
    app = await createApp({
      $queryRawUnsafe: () => Promise.reject(new Error('database unavailable')),
      $disconnect: () => Promise.resolve(undefined),
    });

    const res = await app.inject({ method: 'GET', url: '/readyz' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'error' });
  });

  it('does not route probes under the api/feed/v1 prefix', async () => {
    app = await createApp();

    const res = await app.inject({ method: 'GET', url: '/api/feed/v1/healthz' });

    expect(res.statusCode).toBe(404);
  });

  it('serves internal routes outside the versioned prefix', async () => {
    app = await createApp();

    // Spec 03: internal routes sit at /api/feed/internal/... - a versioned
    // service prefix buries them at /api/feed/v1/internal/... and the
    // fanout worker's upserts 404.
    const internal = await app.inject({ method: 'GET', url: '/api/feed/internal/feed' });
    expect(internal.statusCode).toBe(200);

    const versioned = await app.inject({ method: 'GET', url: '/api/feed/v1/internal/feed' });
    expect(versioned.statusCode).toBe(404);
  });
});
