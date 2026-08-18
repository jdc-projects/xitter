import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { TokenVerifier } from '@xitter/auth';
import { authorizedParty } from '@xitter/auth-nest';
import { createLogger } from '@xitter/observability';
import { WebSocketServer, type WebSocket } from 'ws';
import { feedChannel } from './feed-realtime.js';

const logger = createLogger({ service: 'feed' });

const CHANNEL_PREFIX = 'feed:updates:';

/** Structural slice of ioredis the subscriber needs (unit-testable). */
export interface RedisSubscriber {
  psubscribe(pattern: string): Promise<unknown>;
  on(
    event: 'pmessage',
    listener: (pattern: string, channel: string, message: string) => void,
  ): unknown;
  quit(): Promise<unknown>;
}

export interface FeedGatewayOptions {
  /** The service's HTTP server - upgrades share the API port. */
  server: Server;
  /** Full upgrade path incl. the service prefix: /api/feed/v1/ws. */
  path: string;
  redisUrl: string;
  /** Verifies the connect-time access token (the service's user verifier). */
  verifier: TokenVerifier;
  /** azp allowlist for user tokens (mirrors the AuthGuard default). */
  userClients?: string[];
  /** Test seam: inject a scripted Valkey subscriber. */
  subscriber?: RedisSubscriber;
}

/**
 * WebSocket gateway (spec 03): server-to-client notifications only.
 *
 * Auth: the access token rides the `token` query param (browsers cannot set
 * headers on ws://). It is verified with the same user-token verifier as
 * HTTP routes - the edge cannot validate an upgrade handshake, so the
 * service always re-validates the token itself (`Authorization`/`
 * X-Access-Token` are honoured too). Unauthenticated upgrades are rejected
 * 401 before the socket is accepted.
 *
 * Delivery: one Valkey pattern subscription fans `feed.new-items`
 * notifications to the affected user's sockets. At-most-once per
 * connection - a missed notification is recovered by the next refetch
 * (spec 03 delivery semantics).
 */
export class FeedGateway {
  private readonly wss: WebSocketServer;
  private readonly socketsByUser = new Map<string, Set<WebSocket>>();
  private subscriber?: RedisSubscriber;
  private pingTimer?: NodeJS.Timeout;
  private readonly allowedClients: string[];

  constructor(private readonly options: FeedGatewayOptions) {
    this.allowedClients = options.userClients ?? ['web'];
    // noServer: the service's own HTTP server routes upgrades to this path.
    this.wss = new WebSocketServer({ noServer: true });
    options.server.on('upgrade', (req, socket, head) => {
      void this.handleUpgrade(req, socket, head);
    });
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== this.options.path) {
      socket.destroy();
      return;
    }

    const token =
      url.searchParams.get('token') ?? bearerFromHeaders(req) ?? header(req, 'x-access-token');
    try {
      if (!token) throw new Error('no token presented');
      const auth = await this.options.verifier.verify(token);
      const azp = authorizedParty(auth.claims);
      if (!azp || !this.allowedClients.includes(azp)) {
        throw new Error('token not issued to an allowed client');
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        void this.ensureSubscribed();
        this.onConnection(ws, auth.subject);
      });
    } catch (err) {
      logger.info({ reason: (err as Error).message }, 'ws upgrade rejected');
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  }

  private onConnection(ws: WebSocket, userId: string): void {
    const sockets = this.socketsByUser.get(userId) ?? new Set<WebSocket>();
    sockets.add(ws);
    this.socketsByUser.set(userId, sockets);
    logger.info({ userId }, 'ws client connected');

    ws.on('close', () => {
      const remaining = this.socketsByUser.get(userId);
      remaining?.delete(ws);
      if (remaining && remaining.size === 0) this.socketsByUser.delete(userId);
    });
    ws.on('error', () => ws.terminate());
  }

  /** Fan a published notification out to the user's sockets (contract shape). */
  notifyUser(userId: string): void {
    const sockets = this.socketsByUser.get(userId);
    if (!sockets) return;
    const message = JSON.stringify({ type: 'feed.new-items', count: 1 });
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(message);
    }
  }

  /** Subscribe once per process; degraded (log) when Valkey is unreachable. */
  private async ensureSubscribed(): Promise<void> {
    if (this.subscriber) return;
    try {
      const subscriber = this.options.subscriber ?? (await this.connectValkey());
      await subscriber.psubscribe(`${CHANNEL_PREFIX}*`);
      subscriber.on('pmessage', (_pattern, channel) => {
        const userId = channel.slice(CHANNEL_PREFIX.length);
        if (userId) this.notifyUser(userId);
      });
      this.subscriber = subscriber;
      logger.info('ws pub/sub subscribed to feed:updates:*');
    } catch (err) {
      logger.warn({ err }, 'ws pub/sub subscribe failed - notifications degraded');
    }
  }

  private async connectValkey(): Promise<RedisSubscriber> {
    const { Redis } = await import('ioredis');
    return new Redis(this.options.redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
    }) as unknown as RedisSubscriber;
  }

  /** Liveness: protocol pings every 30s (spec 03); dead connections time out. */
  startPinging(intervalMs = 30_000): void {
    this.pingTimer = setInterval(() => {
      for (const sockets of this.socketsByUser.values()) {
        for (const ws of sockets) ws.ping();
      }
    }, intervalMs);
    this.pingTimer.unref();
  }

  async close(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const sockets of this.socketsByUser.values()) {
      for (const ws of sockets) ws.terminate();
    }
    this.socketsByUser.clear();
    await this.subscriber?.quit().catch(() => undefined);
    this.wss.close();
  }
}

function bearerFromHeaders(req: IncomingMessage): string | undefined {
  const authorization = header(req, 'authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    const token = authorization.slice(7).trim();
    if (token) return token;
  }
  return undefined;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/** The upgrade path the gateway answers (service prefix + ws route). */
export const FEED_WS_PATH = '/api/feed/v1/ws';

export { feedChannel };
