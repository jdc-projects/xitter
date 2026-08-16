import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthModule, type HealthCheckedDb } from './health.module.js';

function fakeDb(overrides: Partial<HealthCheckedDb> = {}): HealthCheckedDb {
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue(1),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function createApp(db: HealthCheckedDb): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [HealthModule.forRoot({ prismaFactory: () => db })],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  return app;
}

describe('HealthModule', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('reports liveness on /healthz without touching the database', async () => {
    const queryRaw = vi.fn().mockResolvedValue(1);
    const db = fakeDb({ $queryRawUnsafe: queryRaw });
    app = await createApp(db);

    const res = await app.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
    expect(db.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('reports readiness on /readyz when the database ping succeeds', async () => {
    const db = fakeDb();
    app = await createApp(db);

    const res = await app.inject({ method: 'GET', url: '/readyz' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', info: { database: { status: 'up' } } });
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('SELECT 1'));
  });

  it('fails readiness with 503 when the database ping errors', async () => {
    const db = fakeDb({ $queryRawUnsafe: vi.fn().mockRejectedValue(new Error('no db')) });
    app = await createApp(db);

    const res = await app.inject({ method: 'GET', url: '/readyz' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'error' });
  });

  it('does not surface an unhandled rejection when the ping rejects after the timeout', async () => {
    // Contract guard: a DB ping that rejects after the 2s race window must
    // never surface as an unhandled rejection (Node's process killer).
    // Promise.race handles its losers today; this pins that so a refactor
    // of the race cannot reintroduce the hazard. Runs in real time: the
    // ping timeout has to fire first.
    const unhandled: string[] = [];
    const onUnhandled = () => unhandled.push('unhandledRejection');
    process.on('unhandledRejection', onUnhandled);
    let rejectPing: (reason: Error) => void = () => {};
    const db = fakeDb({
      $queryRawUnsafe: () =>
        new Promise<unknown>((_, reject) => {
          rejectPing = reject;
        }),
    });
    app = await createApp(db);

    try {
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);

      // The race has settled; the query rejects a tick later.
      rejectPing(new Error('connection terminated'));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('disconnects the database on shutdown', async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    app = await createApp(fakeDb({ $disconnect: disconnect }));

    await app.close();

    expect(disconnect).toHaveBeenCalled();
  });
});
