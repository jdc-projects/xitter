/** Valkey key contracts shared by writers and readers across packages. */

/**
 * Latest reset-run record (JSON ResetStatus, api-contracts) written by the
 * nightly reset job after every run - read by the feed service's internal
 * status endpoint for the admin health tile. Ephemeral by design: the
 * reset's own Valkey flush precedes the write, so the value always
 * describes the most recent run.
 */
export const RESET_STATUS_KEY = 'xitter:reset:status';
