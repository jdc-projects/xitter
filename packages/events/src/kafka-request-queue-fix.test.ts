import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyKafkaRequestQueueFix } from './kafka-request-queue-fix.js';

/**
 * Regression tests for issue #101: kafkajs arms its pending-request re-check
 * timer with `throttledUntil(-1) - Date.now()` on every idle-queue response,
 * producing the TimeoutNegativeWarning at boot AND a self-re-arming ~1ms
 * timer per broker connection for the process lifetime. These drive the real
 * kafkajs RequestQueue class (not a mock) so they fail loudly if either the
 * patch stops applying or kafkajs changes shape.
 */

interface RequestQueueInstance {
  pending: unknown[];
  throttledUntil: number;
  throttleCheckTimeoutId: unknown;
  fulfillRequest(input: { correlationId: number; payload: unknown; size: number }): void;
  push(pushedRequest: {
    entry: { correlationId: number };
    expectResponse: boolean;
    sendRequest(): void;
  }): void;
  destroy(): void;
}

type RequestQueueConstructor = new (options: {
  instrumentationEmitter: unknown;
  maxInFlightRequests: number | null;
  requestTimeout: number;
  enforceRequestTimeout: boolean;
  clientId: string;
  broker: string;
  logger: { debug(): void; warn(): void; error(): void };
  isConnected(): boolean;
}) => RequestQueueInstance;

// Variable specifier: same trick as the fix module - no type resolution of
// the deep path, and resolvable by vitest's ESM transform. Full file path:
// ESM resolution (unlike require) does not expand directories.
const requestQueueModule = 'kafkajs/src/network/requestQueue/index.js';
let RequestQueue: RequestQueueConstructor | undefined;

beforeAll(async () => {
  ({ default: RequestQueue } = (await import(requestQueueModule)) as {
    default: RequestQueueConstructor;
  });
  await applyKafkaRequestQueueFix();
});

function queueConstructor(): RequestQueueConstructor {
  if (!RequestQueue) throw new Error('RequestQueue not loaded');
  return RequestQueue;
}

function makeQueue(): RequestQueueInstance {
  return new (queueConstructor())({
    instrumentationEmitter: null,
    maxInFlightRequests: null,
    requestTimeout: 30_000,
    enforceRequestTimeout: false,
    clientId: 'fix-test',
    broker: 'localhost:9092',
    logger: { debug: () => undefined, warn: () => undefined, error: () => undefined },
    isConnected: () => true,
  });
}

/** Records every (fn, delay) handed to the global setTimeout kafkajs calls. */
function captureSetTimeouts(): { delays: number[]; restore(): void } {
  const delays: number[] = [];
  const spy = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(Number(ms));
      return originalSetTimeout(fn, 0);
    }) as typeof setTimeout);
  return { delays, restore: () => spy.mockRestore() };
}
const originalSetTimeout = globalThis.setTimeout;

const queues: RequestQueueInstance[] = [];
afterEach(() => {
  for (const queue of queues.splice(0)) queue.destroy();
});

describe('kafka request-queue timer fix (#101)', () => {
  it('arms no timer when a response completes on an idle queue', () => {
    const queue = makeQueue();
    queues.push(queue);
    const capture = captureSetTimeouts();

    // The boot path: a broker response arrives with nothing pending and no
    // client-side throttling in effect.
    queue.fulfillRequest({ correlationId: 1, payload: null, size: 0 });

    expect(capture.delays).toHaveLength(0);
    expect(queue.throttleCheckTimeoutId).toBeNull();
    capture.restore();
  });

  it('never schedules a negative or absurd delay (#101 symptom)', () => {
    // The warning's number, stated directly: no scheduling call may carry a
    // negative or absurd (>1 day) delay, from any queue state.
    const queue = makeQueue();
    queues.push(queue);
    const capture = captureSetTimeouts();

    queue.fulfillRequest({ correlationId: 2, payload: null, size: 0 });
    queue.fulfillRequest({ correlationId: 3, payload: null, size: 0 });

    for (const delay of capture.delays) {
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(86_400_000);
    }
    capture.restore();
  });

  it('still schedules a sane re-check when requests are pending', () => {
    const queue = makeQueue();
    queues.push(queue);
    const capture = captureSetTimeouts();

    // Throttled + a queued request: the re-check must still be armed, at the
    // positive distance to the throttle deadline.
    queue.throttledUntil = Date.now() + 5_000;
    queue.push({ entry: { correlationId: 7 }, expectResponse: true, sendRequest: () => undefined });

    expect(queue.pending).toHaveLength(1);
    expect(capture.delays).toHaveLength(1);
    expect(capture.delays[0]).toBeGreaterThan(0);
    expect(capture.delays[0]).toBeLessThanOrEqual(5_000);
    capture.restore();
  });

  it('schedules the fallback interval when pending but not throttled', () => {
    // maxInFlightRequests 0 means nothing can send now: the request enqueues
    // and the re-check arms at kafkajs' CHECK_PENDING_REQUESTS_INTERVAL.
    const overloaded = new (queueConstructor())({
      instrumentationEmitter: null,
      maxInFlightRequests: 0,
      requestTimeout: 30_000,
      enforceRequestTimeout: false,
      clientId: 'fix-test',
      broker: 'localhost:9092',
      logger: { debug: () => undefined, warn: () => undefined, error: () => undefined },
      isConnected: () => true,
    });
    queues.push(overloaded);
    const capture = captureSetTimeouts();

    overloaded.push({
      entry: { correlationId: 8 },
      expectResponse: true,
      sendRequest: () => undefined,
    });

    // Sane = small positive (kafkajs' fallback interval is 10ms).
    const last = capture.delays.at(-1);
    expect(last).toBeDefined();
    expect(last).toBeGreaterThan(0);
    expect(last).toBeLessThanOrEqual(10);
    capture.restore();
  });
});
