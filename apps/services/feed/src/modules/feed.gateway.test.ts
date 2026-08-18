import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { AuthContext, TokenVerifier } from '@xitter/auth';
import { FeedGateway, FEED_WS_PATH, type RedisSubscriber } from './feed.gateway.js';

const USER = '00000000-0000-4000-8000-0000000000f1';

/** Verifier that accepts exactly `good-token` (azp web) and rejects others. */
const verifier: TokenVerifier = {
  verify: async (token: string): Promise<AuthContext> => {
    if (token !== 'good-token') throw new Error('bad token');
    return {
      subject: USER,
      username: 'demo1',
      roles: [],
      claims: { sub: USER, azp: 'web', iss: 'http://localhost:8090/realms/xitter-demo' },
    };
  },
};

/** Capturing Valkey subscriber double: psubscribe resolves, captures handlers. */
function fakeSubscriber(): RedisSubscriber & {
  pmessage(channel: string): void;
  patterns: string[];
} {
  const patterns: string[] = [];
  const listeners: ((pattern: string, channel: string, message: string) => void)[] = [];
  return {
    patterns,
    psubscribe: async (pattern: string) => {
      patterns.push(pattern);
    },
    on: (_event, listener) => {
      listeners.push(listener);
      return this;
    },
    quit: async () => undefined,
    pmessage: (channel: string) => {
      for (const listener of listeners) listener('feed:updates:*', channel, '1');
    },
  };
}

describe('FeedGateway (ws auth + notification relay)', () => {
  let server: Server;
  let gateway: FeedGateway;
  let subscriber: ReturnType<typeof fakeSubscriber>;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${FEED_WS_PATH}`;
    subscriber = fakeSubscriber();
    gateway = new FeedGateway({
      server,
      path: FEED_WS_PATH,
      redisUrl: 'redis://localhost:0', // never reached: subscriber injected
      verifier,
      subscriber,
    });
  });

  afterAll(async () => {
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function connect(url: string): Promise<{ ws: WebSocket; opened: boolean }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      ws.on('open', () => resolve({ ws, opened: true }));
      ws.on('error', () => resolve({ ws, opened: false }));
    });
  }

  function nextMessage(ws: WebSocket): Promise<unknown> {
    return new Promise((resolve) => ws.once('message', (data) => resolve(JSON.parse(String(data)))));
  }

  it('rejects upgrades without a token (401 before the socket is accepted)', async () => {
    const { ws, opened } = await connect(baseUrl);
    expect(opened).toBe(false);
    ws.terminate();
  });

  it('rejects upgrades with an invalid token', async () => {
    const { ws, opened } = await connect(`${baseUrl}?token=wrong`);
    expect(opened).toBe(false);
    ws.terminate();
  });

  it('accepts a valid token and relays feed.new-items notifications', async () => {
    const { ws, opened } = await connect(`${baseUrl}?token=good-token`);
    expect(opened).toBe(true);

    // Connection triggers the pattern subscription.
    await new Promise((r) => setTimeout(r, 20));
    expect(subscriber.patterns).toContain('feed:updates:*');

    const received = nextMessage(ws);
    subscriber.pmessage(`feed:updates:${USER}`);
    await expect(received).resolves.toEqual({ type: 'feed.new-items', count: 1 });

    ws.close();
  });

  it('sends nothing to a user with no sockets subscribed', async () => {
    const { ws, opened } = await connect(`${baseUrl}?token=good-token`);
    expect(opened).toBe(true);
    const stranger = '00000000-0000-4000-8000-0000000000e2';
    let unexpected = 0;
    ws.on('message', () => unexpected++);

    subscriber.pmessage(`feed:updates:${stranger}`);
    await new Promise((r) => setTimeout(r, 25));
    expect(unexpected).toBe(0); // channel isolation
    ws.close();
  });

  it('destroys upgrades to other paths (the API server keeps routing them)', async () => {
    const other = baseUrl.replace(FEED_WS_PATH, '/api/feed/v1/other');
    const { ws, opened } = await connect(other);
    expect(opened).toBe(false);
    ws.terminate();
  });
});
