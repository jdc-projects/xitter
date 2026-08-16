import type Redis from 'ioredis';
import { SESSION_TTL_SECONDS, webEnv } from '../server-env';

export interface SessionRecord {
  subject: string;
  username: string;
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** Epoch ms after which the access token is considered stale. */
  expiresAt: number;
}

export interface LoginState {
  codeVerifier: string;
  nonce: string;
  next: string;
}

export interface SessionStore {
  create(record: SessionRecord, ttlSeconds?: number): Promise<string>;
  get(id: string): Promise<SessionRecord | null>;
  save(id: string, record: SessionRecord, ttlSeconds?: number): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface LoginStateStore {
  set(state: string, value: LoginState, ttlSeconds: number): Promise<void>;
  /** Fetch and delete in one step - login states are single-use. */
  take(state: string): Promise<LoginState | null>;
}

/**
 * In-memory stores: the shape tests and a Valkey-less fallback run against.
 * Sessions die with the process - fine for tests only.
 */
export function memoryStores(): { sessions: SessionStore; logins: LoginStateStore } {
  const sessionMap = new Map<string, SessionRecord>();
  const loginMap = new Map<string, LoginState>();
  return {
    sessions: {
      async create(record) {
        const id = crypto.randomUUID();
        sessionMap.set(id, record);
        return id;
      },
      async get(id) {
        return sessionMap.get(id) ?? null;
      },
      async save(id, record) {
        sessionMap.set(id, record);
      },
      async delete(id) {
        sessionMap.delete(id);
      },
    },
    logins: {
      async set(state, value) {
        loginMap.set(state, value);
      },
      async take(state) {
        const value = loginMap.get(state) ?? null;
        loginMap.delete(state);
        return value;
      },
    },
  };
}

let redisPromise: Promise<Redis> | undefined;

function redis(): Promise<Redis> {
  redisPromise ??= (async () => {
    const { default: RedisCtor } = await import('ioredis');
    return new RedisCtor(webEnv().valkeyUrl, {
      maxRetriesPerRequest: 1,
      lazyConnect: false,
    }) as unknown as Redis;
  })();
  return redisPromise;
}

async function withRedis<T>(operation: (client: Redis) => Promise<T>): Promise<T> {
  const client = await redis();
  return operation(client);
}

/** Valkey-backed session + login-state stores (opaque ids, httpOnly cookie). */
export function valkeyStores(): { sessions: SessionStore; logins: LoginStateStore } {
  const sessionKey = (id: string) => `web:session:${id}`;
  const loginKey = (state: string) => `web:login:${state}`;
  return {
    sessions: {
      async create(record, ttlSeconds = SESSION_TTL_SECONDS) {
        const id = crypto.randomUUID();
        await withRedis((client) =>
          client.set(sessionKey(id), JSON.stringify(record), 'EX', ttlSeconds),
        );
        return id;
      },
      async get(id) {
        const raw = await withRedis((client) => client.get(sessionKey(id)));
        return raw ? (JSON.parse(raw) as SessionRecord) : null;
      },
      async save(id, record, ttlSeconds = SESSION_TTL_SECONDS) {
        await withRedis((client) =>
          client.set(sessionKey(id), JSON.stringify(record), 'EX', ttlSeconds),
        );
      },
      async delete(id) {
        await withRedis((client) => client.del(sessionKey(id)));
      },
    },
    logins: {
      async set(state, value, ttlSeconds) {
        await withRedis((client) =>
          client.set(loginKey(state), JSON.stringify(value), 'EX', ttlSeconds),
        );
      },
      async take(state) {
        const raw = await withRedis((client) => client.getdel(loginKey(state)));
        return raw ? (JSON.parse(raw) as LoginState) : null;
      },
    },
  };
}
