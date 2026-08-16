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

const healthyDb: HealthCheckedDb = {
  $queryRawUnsafe: () => Promise.resolve(1),
  $disconnect: () => Promise.resolve(undefined),
};

async function createApp(dbOverride?: object): Promise<NestFastifyApplication> {
  const builder = Test.createTestingModule({
    imports: [HealthModule.forRoot({ prismaFactory: () => healthyDb })],
    controllers: [PlaceholderController],
  });
  if (dbOverride) builder.overrideProvider(HEALTH_DB).useValue(dbOverride);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  // Mirrors main.ts: probes sit at the root, outside the versioned prefix.
  // Only this prefix wiring is replicated here - main.ts's bootstrap config
  // (env parsing, tracing, Sentry) isn't unit-testable.
  app.setGlobalPrefix('api/social/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();
  return app;
}

describe('health probe wiring', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('serves liveness at the root, outside the api/social/v1 prefix', async () => {
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

  it('does not route probes under the api/social/v1 prefix', async () => {
    app = await createApp();

    const res = await app.inject({ method: 'GET', url: '/api/social/v1/healthz' });

    expect(res.statusCode).toBe(404);
  });
});
