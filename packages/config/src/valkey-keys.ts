/** Valkey key contracts shared by writers and readers across packages. */

/**
 * Latest reset-run record (JSON ResetStatus, api-contracts) written by the
 * nightly reset job after every run - read by the feed service's internal
 * status endpoint for the admin health tile. Ephemeral by design: the
 * reset's own Valkey flush precedes the write, so the value always
 * describes the most recent run.
 */
export const RESET_STATUS_KEY = 'xitter:reset:status';

/**
 * The reset epoch (integer, monotonically bumped per reset run). Its
 * PRESENCE means "a reset is in progress": workers observe it via the
 * epoch gate (packages/events) and pause themselves; the reset deletes the
 * key when the wipe completes, which is the workers' resume signal.
 * Written AFTER the flow's Valkey flush (the flush clears stale epoch
 * state while workers are still live - harmless, they just keep consuming).
 */
export const RESET_EPOCH_KEY = 'xitter:reset:epoch';

/** The workers that must acknowledge a reset epoch before stores are wiped. */
export const RESET_WORKERS = ['fanout', 'media-process', 'search-index'] as const;

export type ResetWorkerName = (typeof RESET_WORKERS)[number];

/**
 * A worker's "I have paused for epoch N" heartbeat. The reset's
 * wait-workers-paused step polls these for every RESET_WORKERS member
 * matching the epoch it just wrote; clearResetEpoch deletes them.
 */
export const resetPausedKey = (worker: string): string => `xitter:reset:paused:${worker}`;
