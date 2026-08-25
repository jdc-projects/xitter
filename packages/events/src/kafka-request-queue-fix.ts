/**
 * kafkajs request-queue timer fix (issue #101).
 *
 * kafkajs (2.2.4, 2.3.0-beta.3 and master as of 2026-08) computes its
 * pending-request re-check delay as `throttledUntil - Date.now()` and hands
 * it to setTimeout unclamped. `throttledUntil` starts at -1 and never moves
 * without broker-advertised client-side throttling, so the first response on
 * an idle queue (the boot handshake of every service's eager producer
 * connect) schedules `setTimeout(-1 - Date.now())` — the epoch-sized
 * negative number in every service's boot log. Node clamps it to 1ms, the
 * callback re-arms itself at the top of checkPendingRequests, and the loop
 * never stops: every broker connection spins a ~1ms timer for the whole
 * process lifetime (~1.4k wakeups/s measured on an idle social service).
 *
 * No fixed release exists upstream, so narrow the scheduling to the only
 * state the timer exists for: pending requests to re-check. A throttled but
 * idle queue needs no wake-up either — the next push() while throttled
 * schedules one at the (positive) throttle deadline itself, so no wakeup is
 * lost. Applied from every module that constructs a Kafka client; idempotent.
 *
 * Defensive by design: if kafkajs restructures the queue this no-ops, and
 * kafka-request-queue-fix.test.ts fails against the real class, pinning the
 * patch to a shape that actually exists.
 */

/** Structural slice of the queue state the guard reads. */
interface PatchedRequestQueue {
  throttleCheckTimeoutId: unknown;
  pending: unknown[];
}

type ScheduleCheck = (this: PatchedRequestQueue) => void;

interface RequestQueueConstructor {
  prototype: { scheduleCheckPendingRequests: ScheduleCheck };
}

// Variable specifier: keeps tsc from resolving (and rejecting) the deep
// CommonJS path, while dynamic import works from both the CJS build output
// and the ESM transform vitest runs. Full file path: ESM resolution (unlike
// require) does not expand directories.
const requestQueueModule = 'kafkajs/src/network/requestQueue/index.js';

let applied = false;

export async function applyKafkaRequestQueueFix(): Promise<void> {
  if (applied) return;
  applied = true;

  try {
    const queueModule = (await import(requestQueueModule)) as {
      default: RequestQueueConstructor;
    };
    const original = queueModule.default?.prototype?.scheduleCheckPendingRequests;
    if (typeof original !== 'function') return;

    queueModule.default.prototype.scheduleCheckPendingRequests = function (
      this: PatchedRequestQueue,
    ) {
      // Already armed, or nothing waiting that a re-check could send: do not
      // arm a timer at all. (Upstream arms one at a negative epoch delay.)
      if (this.throttleCheckTimeoutId || this.pending.length === 0) return;
      original.call(this);
    };
  } catch {
    // kafkajs is a hard dependency of this package; if the deep path ever
    // disappears the regression test fails, so staying quiet here is safe.
  }
}
