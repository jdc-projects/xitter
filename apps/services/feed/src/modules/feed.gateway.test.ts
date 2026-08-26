import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { connect as netConnect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { feedUpdatesChannel } from '@xitter/api-contracts';
import type { AuthContext, TokenVerifier } from '@xitter/auth';
import { FeedGateway, FEED_WS_PATH, type FeedGatewayOptions, type RedisSubscriber } from './feed.gateway.js';
import { ValkeyFeedRealtime, feedChannel } from './feed-realtime.js';

const USER = '00000000-0000-4000-8000-0000000000f1';
const OTHER_USER = '00000000-0000-4000-8000-0000000000f2';
const STRANGER = '00000000-0000-4000-8000-0000000000e2';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until true - deterministic waits for async gateway internals. */
async function waitFor(check: () => boolean, label = 'condition', timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(10);
  }
}

/** Verifier mapping tokens to (subject, azp); unknown tokens are rejected. */
function verifierFor(tokens: Record<string, { subject: string; azp?: string }>): TokenVerifier {
  return {
    verify: async (token: string): Promise<AuthContext> => {
      const entry = tokens[token];
      if (!entry) throw new Error('bad token');
      return {
        subject: entry.subject,
        username: 'demo',
        roles: [],
        audience: 'svc-feed',
        claims: {
          sub: entry.subject,
          ...(entry.azp ? { azp: entry.azp } : {}),
          iss: 'http://localhost:8090/realms/xitter-demo',
        },
      };
    },
  };
}

const defaultVerifier = verifierFor({
  'good-token': { subject: USER, azp: 'web' },
  'other-user-token': { subject: OTHER_USER, azp: 'web' },
});

/** A gateway + throwaway HTTP server sharing its upgrade port. */
async function startGateway(overrides: Partial<FeedGatewayOptions> = {}): Promise<{
  server: Server;
  gateway: FeedGateway;
  url: string;
}> {
  const server = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const gateway = new FeedGateway({
    server,
    path: FEED_WS_PATH,
    redisUrl: 'redis://localhost:0', // unreachable by design: tests inject a subscriber
    verifier: defaultVerifier,
    ...overrides,
  });
  return { server, gateway, url: `ws://127.0.0.1:${port}${FEED_WS_PATH}` };
}

async function stopGateway(state: { server: Server; gateway: FeedGateway }): Promise<void> {
  await state.gateway.close();
  await new Promise<void>((resolve) => state.server.close(() => resolve()));
}

function connect(
  url: string,
  headers?: Record<string, string | string[]>,
): Promise<{ ws: WebSocket; opened: boolean; error: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    let settled = false;
    ws.on('open', () => {
      settled = true;
      resolve({ ws, opened: true, error: '' });
    });
    ws.on('error', (err: Error) => {
      if (!settled) {
        settled = true;
        resolve({ ws, opened: false, error: err.message });
      }
    });
  });
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) =>
    ws.once('message', (data) => resolve(JSON.parse(String(data)))),
  );
}

/**
 * Hand-rolled HTTP upgrade over a raw socket, resolving with the response's
 * status line - pins the exact wire response (401 vs 101) rather than the ws
 * client's rendering of it.
 */
function rawUpgrade(
  port: number,
  pathname: string,
  headerLines: [string, string][],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ port, host: '127.0.0.1' });
    socket.once('error', reject);
    socket.once('data', (chunk: Buffer) => {
      resolve(chunk.toString('utf8').split('\r\n')[0]!);
      socket.destroy();
    });
    socket.once('connect', () => {
      const request = [
        `GET ${pathname} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        ...headerLines.map(([name, value]) => `${name}: ${value}`),
        '',
        '',
      ].join('\r\n');
      socket.write(request);
    });
  });
}

const portOf = (url: string): number => Number(new URL(url).port);

/** Collect every notification a socket receives, parsed. */
function collector(ws: WebSocket): { messages: unknown[] } {
  const messages: unknown[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(String(data))));
  return { messages };
}

/** Capturing Valkey subscriber double: psubscribe resolves, captures handlers. */
function fakeSubscriber(): RedisSubscriber & {
  pmessage(channel: string): void;
  patterns: string[];
  quits: number;
} {
  const patterns: string[] = [];
  const listeners: ((pattern: string, channel: string, message: string) => void)[] = [];
  const subscriber = {
    patterns,
    quits: 0,
    psubscribe: async (pattern: string) => {
      patterns.push(pattern);
    },
    on: (
      _event: 'pmessage',
      listener: (pattern: string, channel: string, message: string) => void,
    ) => {
      listeners.push(listener);
      return subscriber;
    },
    quit: async () => {
      subscriber.quits += 1;
    },
    pmessage: (channel: string) => {
      for (const listener of listeners) listener('feed:updates:*', channel, '1');
    },
  };
  return subscriber;
}

/**
 * Subscriber double whose psubscribe always rejects - the "Valkey is down at
 * boot" posture. Models the per-attempt fresh client the real wiring creates
 * (each attempt is handed its own connection to quit or keep).
 */
function failingSubscriber(): RedisSubscriber & {
  attempts: number;
  quits: number;
} {
  const subscriber = {
    attempts: 0,
    quits: 0,
    psubscribe: async () => {
      subscriber.attempts += 1;
      throw new Error('subscribe refused (valkey down)');
    },
    on: () => subscriber,
    quit: async () => {
      subscriber.quits += 1;
    },
  };
  return subscriber;
}

/**
 * In-memory Valkey pub/sub with real routing semantics (the #119 lesson:
 * bare vi.fn() doubles model error shapes a live broker never emits).
 * Publisher connections fan every publish out to pattern subscribers whose
 * glob pattern matches the channel, invoking the ioredis `pmessage`
 * contract (pattern, channel, message).
 */
function fakeValkeyBus() {
  type Listener = (pattern: string, channel: string, message: string) => void;
  const subscribers: { patterns: string[]; listeners: Listener[] }[] = [];
  return {
    /** Publisher connection (ValkeyFeedRealtime's structural slice). */
    async connect(): Promise<{ publish(channel: string, message: string): Promise<number> }> {
      return {
        async publish(channel: string, message: string) {
          for (const subscriber of subscribers) {
            for (const pattern of subscriber.patterns) {
              const matched = pattern.endsWith('*')
                ? channel.startsWith(pattern.slice(0, -1))
                : pattern === channel;
              if (matched) {
                for (const listener of [...subscriber.listeners]) listener(pattern, channel, message);
              }
            }
          }
          return 1;
        },
      };
    },
    /**
     * Subscriber connection (the gateway's structural slice). `ready`
     * resolves once the gateway has both pattern-subscribed and attached its
     * pmessage listener, so tests never race subscription setup.
     */
    subscriber(): RedisSubscriber & { ready: Promise<void> } {
      const state = { patterns: [] as string[], listeners: [] as Listener[] };
      subscribers.push(state);
      let signalReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        signalReady = resolve;
      });
      const connection = {
        async psubscribe(pattern: string) {
          state.patterns.push(pattern);
          return 1;
        },
        on(_event: 'pmessage', listener: Listener) {
          state.listeners.push(listener);
          signalReady();
          return connection;
        },
        async quit() {
          state.patterns = [];
          state.listeners = [];
          return 'OK';
        },
        ready,
      };
      return connection;
    },
  };
}

describe('FeedGateway (ws auth + notification relay)', () => {
  let state: Awaited<ReturnType<typeof startGateway>>;
  let subscriber: ReturnType<typeof fakeSubscriber>;
  let url: string;

  beforeAll(async () => {
    subscriber = fakeSubscriber();
    state = await startGateway({ subscriber });
    url = state.url;
  });

  afterAll(() => stopGateway(state));

  it('rejects upgrades without a token with a 401 status line (before the socket is accepted)', async () => {
    const { ws, opened, error } = await connect(url);
    expect(opened).toBe(false);
    expect(error).toContain('401');

    const status = await rawUpgrade(portOf(url), FEED_WS_PATH, []);
    expect(status).toBe('HTTP/1.1 401 Unauthorized');
    ws.terminate();
  });

  it('rejects upgrades with an invalid token', async () => {
    const { ws, opened, error } = await connect(`${url}?token=wrong`);
    expect(opened).toBe(false);
    expect(error).toContain('401');
    ws.terminate();
  });

  it('accepts a valid token and relays feed.new-items notifications', async () => {
    const { ws, opened } = await connect(`${url}?token=good-token`);
    expect(opened).toBe(true);

    // Connection triggers the pattern subscription.
    await waitFor(() => subscriber.patterns.includes('feed:updates:*'), 'psubscribe');
    expect(subscriber.patterns).toEqual(['feed:updates:*']);

    const received = nextMessage(ws);
    subscriber.pmessage(`feed:updates:${USER}`);
    await expect(received).resolves.toEqual({ type: 'feed.new-items', count: 1 });

    ws.close();
  });

  it('sends nothing to a user with no sockets subscribed', async () => {
    const { ws, opened } = await connect(`${url}?token=good-token`);
    expect(opened).toBe(true);
    const inbox = collector(ws);

    subscriber.pmessage(`feed:updates:${STRANGER}`);
    await sleep(25);
    expect(inbox.messages).toEqual([]); // channel isolation
    ws.close();
  });

  it('destroys upgrades to other paths (the API server keeps routing them)', async () => {
    const other = url.replace(FEED_WS_PATH, '/api/feed/v1/other');
    const { ws, opened } = await connect(other);
    expect(opened).toBe(false);
    ws.terminate();
  });
});

describe('FeedGateway handshake: token sources and the azp allowlist', () => {
  let state: Awaited<ReturnType<typeof startGateway>>;
  let url: string;

  beforeAll(async () => {
    state = await startGateway({
      verifier: verifierFor({
        'good-token': { subject: USER, azp: 'web' },
        // Cryptographically valid but wrong party: a service token.
        'service-token': { subject: STRANGER, azp: 'svc-posts' },
        // Valid but azp-less (legacy/edge-minted) token.
        'legacy-token': { subject: STRANGER },
      }),
    });
    url = state.url;
  });

  afterAll(() => stopGateway(state));

  it('honours Authorization: Bearer', async () => {
    const { ws, opened } = await connect(url, { authorization: 'Bearer good-token' });
    expect(opened).toBe(true);
    ws.close();
  });

  it('honours X-Access-Token', async () => {
    const { ws, opened } = await connect(url, { 'x-access-token': 'good-token' });
    expect(opened).toBe(true);
    ws.close();
  });

  it('treats a malformed Authorization header as no token (401)', async () => {
    const { ws, opened, error } = await connect(url, { authorization: 'good-token' });
    expect(opened).toBe(false);
    expect(error).toContain('401');
    ws.terminate();
  });

  it('the token query param wins over a contradicting header', async () => {
    // The query token is authoritative: browsers cannot set ws headers.
    const { ws, opened, error } = await connect(`${url}?token=wrong`, {
      authorization: 'Bearer good-token',
    });
    expect(opened).toBe(false);
    expect(error).toContain('401');
    ws.terminate();
  });

  it('rejects a valid token issued to a client outside the allowlist', async () => {
    const { ws, opened, error } = await connect(url, { authorization: 'Bearer service-token' });
    expect(opened).toBe(false);
    expect(error).toContain('401');
    ws.terminate();
  });

  it('rejects a valid token with no authorized party claim', async () => {
    const { ws, opened, error } = await connect(url, { authorization: 'Bearer legacy-token' });
    expect(opened).toBe(false);
    expect(error).toContain('401');
    ws.terminate();
  });
});

describe('FeedGateway handshake: a custom client allowlist', () => {
  let state: Awaited<ReturnType<typeof startGateway>>;
  let url: string;

  beforeAll(async () => {
    state = await startGateway({
      userClients: ['admin-panel'],
      verifier: verifierFor({
        'admin-token': { subject: USER, azp: 'admin-panel' },
        'web-token': { subject: USER, azp: 'web' },
      }),
    });
    url = state.url;
  });

  afterAll(() => stopGateway(state));

  it('accepts the configured client and still rejects the default one', async () => {
    const admin = await connect(url, { authorization: 'Bearer admin-token' });
    expect(admin.opened).toBe(true);
    admin.ws.close();

    const web = await connect(url, { authorization: 'Bearer web-token' });
    expect(web.opened).toBe(false);
    web.ws.terminate();
  });
});

describe('FeedGateway pub/sub subscription lifecycle', () => {
  it('subscribes exactly once per process however many clients connect', async () => {
    const subscriber = fakeSubscriber();
    const state = await startGateway({ subscriber });
    try {
      const first = await connect(`${state.url}?token=good-token`);
      const second = await connect(`${state.url}?token=good-token`);
      const third = await connect(`${state.url}?token=good-token`);
      await waitFor(() => subscriber.patterns.length > 0, 'psubscribe');

      expect(subscriber.patterns).toEqual(['feed:updates:*']); // one, not three

      first.ws.close();
      second.ws.close();
      third.ws.close();
    } finally {
      await stopGateway(state);
    }
  });

  it('quits the orphaned subscriber when the subscribe fails, and retries on the next connection', async () => {
    const subscriber = failingSubscriber();
    const state = await startGateway({ subscriber });
    try {
      const first = await connect(`${state.url}?token=good-token`);
      const second = await connect(`${state.url}?token=good-token`);
      await waitFor(() => subscriber.attempts >= 2, 'retrying psubscribe');

      // One quit per failed attempt: no subscriber is left retrying untended.
      expect(subscriber.quits).toBe(2);
      expect(subscriber.attempts).toBe(2);
      // Degraded, not broken: the sockets stay accepted and idle.
      expect(first.ws.readyState).toBe(first.ws.OPEN);
      expect(second.ws.readyState).toBe(second.ws.OPEN);

      first.ws.close();
      second.ws.close();
    } finally {
      await stopGateway(state);
    }
  });
});

describe('FeedGateway fan-out over the Valkey bus (real routing)', () => {
  let state: Awaited<ReturnType<typeof startGateway>>;
  let bus: ReturnType<typeof fakeValkeyBus>;
  let subscriber: RedisSubscriber & { ready: Promise<void> };
  let realtime: ValkeyFeedRealtime;

  beforeAll(async () => {
    bus = fakeValkeyBus();
    subscriber = bus.subscriber();
    state = await startGateway({ subscriber });
    realtime = new ValkeyFeedRealtime('redis://valkey:6379', () => bus.connect());
  });

  afterAll(() => stopGateway(state));

  it('delivers a fanout publish to the affected user socket through the bus', async () => {
    const { ws, opened } = await connect(`${state.url}?token=good-token`);
    expect(opened).toBe(true);
    await subscriber.ready;

    const received = nextMessage(ws);
    await realtime.notify([USER]);
    await expect(received).resolves.toEqual({ type: 'feed.new-items', count: 1 });

    ws.close();
  });

  it('delivers posts-side author pings on the api-contracts channel', async () => {
    // posts publishes via feedUpdatesChannel(); the gateway pattern-matches
    // feed:updates:* - a drift on either side would silently kill pings.
    const { ws, opened } = await connect(`${state.url}?token=good-token`);
    expect(opened).toBe(true);
    await subscriber.ready;

    const received = nextMessage(ws);
    const publisher = await bus.connect();
    await publisher.publish(feedUpdatesChannel(USER), '1');
    await expect(received).resolves.toEqual({ type: 'feed.new-items', count: 1 });
    expect(feedChannel(USER)).toBe(feedUpdatesChannel(USER));

    ws.close();
  });

  it('routes a publish for another user to nobody on this connection', async () => {
    const { ws, opened } = await connect(`${state.url}?token=good-token`);
    expect(opened).toBe(true);
    await subscriber.ready;
    const inbox = collector(ws);

    await realtime.notify([STRANGER]);
    await sleep(25);
    expect(inbox.messages).toEqual([]);

    ws.close();
  });
});

describe('FeedGateway socket registry and liveness (leak-safety)', () => {
  let state: Awaited<ReturnType<typeof startGateway>>;
  let subscriber: ReturnType<typeof fakeSubscriber>;
  let url: string;

  beforeAll(async () => {
    subscriber = fakeSubscriber();
    state = await startGateway({ subscriber });
    url = state.url;
  });

  afterAll(() => stopGateway(state));

  /** Wait for the server to have drained a client-initiated close. */
  const settle = () => sleep(30);

  it('fans a notification to every socket in the user room, and only that room', async () => {
    const sameUserA = await connect(`${url}?token=good-token`);
    const sameUserB = await connect(`${url}?token=good-token`);
    const other = await connect(`${url}?token=other-user-token`);
    expect(sameUserA.opened && sameUserB.opened && other.opened).toBe(true);
    const inboxA = collector(sameUserA.ws);
    const inboxB = collector(sameUserB.ws);
    const inboxOther = collector(other.ws);

    subscriber.pmessage(feedChannel(USER));
    await sleep(25);

    expect(inboxA.messages).toEqual([{ type: 'feed.new-items', count: 1 }]);
    expect(inboxB.messages).toEqual([{ type: 'feed.new-items', count: 1 }]);
    expect(inboxOther.messages).toEqual([]);

    sameUserA.ws.close();
    sameUserB.ws.close();
    other.ws.close();
  });

  it('stops notifying a socket once it disconnects (registry drains)', async () => {
    const a = await connect(`${url}?token=good-token`);
    const b = await connect(`${url}?token=good-token`);
    const inboxB = collector(b.ws);
    a.ws.close();
    await settle();

    subscriber.pmessage(feedChannel(USER));
    await sleep(25);
    expect(inboxB.messages).toEqual([{ type: 'feed.new-items', count: 1 }]); // only b

    b.ws.close();
    await settle();
    subscriber.pmessage(feedChannel(USER)); // room is empty: a silent no-op
    await sleep(25);
    expect(inboxB.messages).toHaveLength(1);
  });

  it('reconnects after churn deliver exactly one copy (no ghost registrations)', async () => {
    for (let cycle = 0; cycle < 3; cycle++) {
      const ephemeral = await connect(`${url}?token=good-token`);
      ephemeral.ws.close();
      await settle();
    }

    const fresh = await connect(`${url}?token=good-token`);
    const inbox = collector(fresh.ws);
    subscriber.pmessage(feedChannel(USER));
    await sleep(25);
    expect(inbox.messages).toEqual([{ type: 'feed.new-items', count: 1 }]); // one, not four

    fresh.ws.close();
  });

  it('pings every live socket on the interval, and close() stops the pings and quits the subscriber', async () => {
    // Its own gateway: this test drives close() itself.
    const subscriber = fakeSubscriber();
    const own = await startGateway({ subscriber });
    try {
      const a = await connect(`${own.url}?token=good-token`);
      const b = await connect(`${own.url}?token=other-user-token`);
      const pings = { a: 0, b: 0 };
      a.ws.on('ping', () => pings.a++);
      b.ws.on('ping', () => pings.b++);

      own.gateway.startPinging(25);
      await waitFor(() => pings.a >= 2 && pings.b >= 2, 'protocol pings on both sockets');

      const closedA = new Promise<void>((resolve) => a.ws.once('close', resolve));
      const closedB = new Promise<void>((resolve) => b.ws.once('close', resolve));
      await own.gateway.close();
      await Promise.all([closedA, closedB]); // every socket terminated

      expect(subscriber.quits).toBe(1); // the subscriber was released too
      const settledA = pings.a;
      const settledB = pings.b;
      await sleep(100); // four missed intervals: the timer is really cleared
      expect(pings.a).toBe(settledA);
      expect(pings.b).toBe(settledB);
    } finally {
      await stopGateway(own);
    }
  });
});
