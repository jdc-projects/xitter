import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { HEALTH_DB } from '@xitter/health';
import { AppModule } from './app.module.js';

async function createApp(dbOverride?: object): Promise<NestFastifyApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (dbOverride) builder.overrideProvider(HEALTH_DB).useValue(dbOverride);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  // Mirrors main.ts: probes sit at the root, outside the versioned prefix.
  app.setGlobalPrefix('api/feed/v1', { exclude: ['healthz', 'readyz'] });
  await app.init();
  return app;
}

describe('AppModule health wiring', () => {
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
});
