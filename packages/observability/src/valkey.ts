/**
 * Lazy single-connection Valkey (ioredis) helper shared by the runtime
 * consumers of Valkey (feed ws notifications, posts interaction pings, the
 * reset-status reader): one handshake policy, fail-fast posture, and no
 * leaked retrying clients when the handshake fails.
 */

/** Structural slice of ioredis these consumers need (unit-testable). */
export interface ValkeyConnection {
  quit(): Promise<unknown>;
}

export interface ValkeyConnectOptions {
  url: string;
  connectTimeoutMs?: number;
}

/**
 * Connect and await readiness once, typed as the caller's structural slice
 * of ioredis (publish, get, ...). `enableOfflineQueue:false` makes commands
 * during the lazy-connect window throw; awaiting the handshake means the
 * first real command (often a user-facing publish) does not race connection
 * setup. A failed handshake disconnects the retrying client so concurrent
 * callers cannot accumulate them.
 */
export async function connectValkey<T extends ValkeyConnection>(
  options: ValkeyConnectOptions,
): Promise<T> {
  const { Redis } = await import('ioredis');
  const connection = new Redis(options.url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: options.connectTimeoutMs ?? 2_000,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      connection.once('ready', () => resolve());
      connection.once('error', (err: Error) => reject(err));
    });
  } catch (err) {
    connection.disconnect();
    throw err;
  }
  return connection as unknown as T;
}
