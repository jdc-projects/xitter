import { describe, expect, it } from 'vitest';
import { feedUpdatesChannel, type FeedEntryInput } from '@xitter/api-contracts';
import { FeedService } from './feed.service.js';
import { CheckpointRepository, type FeedCheckpointDb } from './checkpoint.repository.js';
import type { ContentHydrator } from './content-hydrator.js';
import type { FeedRepository } from './feed.repository.js';
import { ValkeyFeedRealtime, feedChannel } from './feed-realtime.js';

// Never exercised in this suite (checkpoint behaviour lives with the fanout
// wiring); a quiet null delegate keeps the FeedService seam satisfied.
const quietCheckpoints = new CheckpointRepository({
  feedCheckpoint: {
    upsert: async () => ({}),
    findMany: async () => [],
    deleteMany: async () => ({ count: 0 }),
  },
} as unknown as FeedCheckpointDb);

const OWNER = '00000000-0000-4000-8000-000000000001';
const FOLLOWEE = '00000000-0000-4000-8000-000000000002';
const STRANGER = '00000000-0000-4000-8000-000000000003';

type PmessageListener = (pattern: string, channel: string, message: string) => void;

/**
 * In-memory Valkey pub/sub with real routing semantics (the #119 lesson:
 * bare vi.fn() doubles model error shapes a live broker never emits).
 * `connect()` hands out publisher connections whose publishes fan out to
 * every pattern subscriber whose glob pattern matches the channel, invoking
 * the ioredis `pmessage` contract (pattern, channel, message). The test
 * flips `down`/`failPublish`/`failQuit` to script outages.
 */
function fakeValkeyBus() {
  const deliveries: { pattern: string; channel: string; message: string }[] = [];
  const subscribers: { patterns: string[]; listeners: PmessageListener[] }[] = [];
  const connections: { quits: number }[] = [];
  const bus = {
    deliveries,
    connections,
    /** Scripted outage: reject new connections. */
    down: false,
    /** Scripted outage: commands on live connections reject. */
    failPublish: false,
    /** Scripted outage: quit() rejects (the seam must still swallow it). */
    failQuit: false,
    /** How many connections were handed out - the reuse/leak observable. */
    connectCount: 0,
    /** The publisher half (feed-realtime's structural slice of ioredis). */
    async connect(): Promise<{
      publish(channel: string, message: string): Promise<number>;
      quit(): Promise<'OK'>;
      quits: number;
    }> {
      if (bus.down) throw new Error('connection refused (valkey down)');
      bus.connectCount += 1;
      const connection = {
        quits: 0,
        async publish(channel: string, message: string) {
          if (bus.failPublish) throw new Error('publish refused (valkey restarted)');
          for (const subscriber of subscribers) {
            for (const pattern of subscriber.patterns) {
              const matched = pattern.endsWith('*')
                ? channel.startsWith(pattern.slice(0, -1))
                : pattern === channel;
              if (matched) {
                for (const listener of [...subscriber.listeners]) {
                  listener(pattern, channel, message);
                }
                deliveries.push({ pattern, channel, message });
              }
            }
          }
          return 1;
        },
        async quit() {
          connection.quits += 1;
          if (bus.failQuit) throw new Error('quit refused');
          return 'OK' as const;
        },
      };
      connections.push(connection);
      return connection;
    },
    /** Subscriber standing in for the gateway's pattern subscription. */
    subscriber(pattern: string): { patterns: string[] } {
      const state = { patterns: [pattern], listeners: [] as PmessageListener[] };
      subscribers.push(state);
      return { patterns: state.patterns };
    },
  };
  return bus;
}

/** Realtime over the scripted bus - the production wiring minus the socket. */
const realtimeOver = (bus: ReturnType<typeof fakeValkeyBus>) =>
  new ValkeyFeedRealtime('redis://valkey:6379', () => bus.connect());

describe('ValkeyFeedRealtime notify (contract: feed:updates channels)', () => {
  it('publishes one notification per user on the contract channel', async () => {
    const bus = fakeValkeyBus();
    const gateway = bus.subscriber('feed:updates:*'); // the gateway's pattern
    const realtime = realtimeOver(bus);

    await realtime.notify([OWNER, FOLLOWEE]);

    expect(bus.deliveries).toEqual([
      { pattern: 'feed:updates:*', channel: feedChannel(OWNER), message: '1' },
      { pattern: 'feed:updates:*', channel: feedChannel(FOLLOWEE), message: '1' },
    ]);
    expect(gateway.patterns).toEqual(['feed:updates:*']);
    // posts pings the same channel via api-contracts - both ends must agree.
    expect(feedChannel(OWNER)).toBe(feedUpdatesChannel(OWNER));
  });

  it('is a no-op for an empty recipient list (no connection is attempted)', async () => {
    const bus = fakeValkeyBus();
    const realtime = realtimeOver(bus);

    await expect(realtime.notify([])).resolves.toBeUndefined();

    expect(bus.connectCount).toBe(0);
    expect(bus.deliveries).toEqual([]);
  });
});

describe('ValkeyFeedRealtime best-effort semantics (notify never fails the write path)', () => {
  it('resolves - never rejects - while Valkey is unreachable', async () => {
    const bus = fakeValkeyBus();
    bus.down = true;

    await expect(realtimeOver(bus).notify([OWNER])).resolves.toBeUndefined();
  });

  it('resolves when a publish on a live connection fails', async () => {
    const bus = fakeValkeyBus();
    const realtime = realtimeOver(bus);
    bus.subscriber('feed:updates:*');
    await realtime.notify([OWNER]); // connection established and healthy

    bus.failPublish = true;
    await expect(realtime.notify([OWNER])).resolves.toBeUndefined();
  });

  it('drops the dead connection (quit) and reconnects on the next notify', async () => {
    const bus = fakeValkeyBus();
    const realtime = realtimeOver(bus);
    bus.subscriber('feed:updates:*');
    await realtime.notify([OWNER]);

    bus.failPublish = true;
    await realtime.notify([OWNER]); // fails; the dead handle is dropped
    bus.failPublish = false;
    await realtime.notify([OWNER]); // reconnects

    expect(bus.connectCount).toBe(2); // not 3: the outage dropped, not kept, the handle
    expect(bus.connections[0]!.quits).toBe(1); // the dead connection was released
    expect(bus.deliveries).toHaveLength(2); // first and recovered notify both landed
  });

  it('reuses one lazily-created connection across notifies', async () => {
    const bus = fakeValkeyBus();
    const realtime = realtimeOver(bus);
    bus.subscriber('feed:updates:*');

    await realtime.notify([OWNER]);
    await realtime.notify([FOLLOWEE]);
    await realtime.notify([OWNER, STRANGER]);

    expect(bus.connectCount).toBe(1);
    expect(bus.deliveries).toHaveLength(4);
  });

  it('an outage-and-recover cycle creates exactly one connection, not one per notify', async () => {
    const bus = fakeValkeyBus();
    const realtime = realtimeOver(bus);
    bus.subscriber('feed:updates:*');

    bus.down = true;
    await realtime.notify([OWNER]);
    await realtime.notify([OWNER]);
    await realtime.notify([OWNER]);

    bus.down = false;
    await realtime.notify([OWNER]);

    expect(bus.connectCount).toBe(1); // only the recovered, working connection
    expect(bus.deliveries).toEqual([
      { pattern: 'feed:updates:*', channel: feedChannel(OWNER), message: '1' },
    ]);
  });
});

describe('ValkeyFeedRealtime stop (shutdown leak-safety)', () => {
  it('releases the live connection', async () => {
    const bus = fakeValkeyBus();
    const realtime = realtimeOver(bus);
    await realtime.notify([OWNER]);

    await expect(realtime.stop()).resolves.toBeUndefined();

    expect(bus.connections).toHaveLength(1);
    expect(bus.connections[0]!.quits).toBe(1);
  });

  it('is safe to call when no connection was ever opened', async () => {
    const bus = fakeValkeyBus();

    await expect(realtimeOver(bus).stop()).resolves.toBeUndefined();

    expect(bus.connectCount).toBe(0);
  });

  it('swallows a quit failure at shutdown', async () => {
    const bus = fakeValkeyBus();
    const realtime = realtimeOver(bus);
    await realtime.notify([OWNER]);

    bus.failQuit = true;
    await expect(realtime.stop()).resolves.toBeUndefined();
  });
});

/**
 * Minimal FeedService repo double for the upsert path only - proves the
 * fanout write commits while the notification seam degrades.
 */
function fakeUpsertRepo() {
  const rows = new Map<string, FeedEntryInput>();
  const repo = {
    upsertEntries: (entries: FeedEntryInput[]) => {
      let fresh = 0;
      for (const entry of entries) {
        const key = `${entry.userId}|${entry.postId}|${entry.reason}`;
        if (rows.has(key)) continue;
        rows.set(key, entry);
        fresh += 1;
      }
      return Promise.resolve(fresh);
    },
    // The service only maps shapes through this before upserting.
    toNewEntry: (input: FeedEntryInput) => input,
  };
  return { repo: repo as unknown as FeedRepository, rows };
}

describe('fanout write path survives a Valkey outage (best-effort end to end)', () => {
  it('commits entries while Valkey is down, then notifies once it recovers', async () => {
    const bus = fakeValkeyBus();
    const realtime = realtimeOver(bus);
    bus.subscriber('feed:updates:*');
    const { repo, rows } = fakeUpsertRepo();
    const hydrator = {
      posts: () => Promise.resolve(new Map()),
      profiles: () => Promise.resolve(new Map()),
      blockedAuthorIds: () => Promise.resolve([]),
    } as unknown as ContentHydrator;
    const service = new FeedService(repo, hydrator, realtime, quietCheckpoints);

    const input = (userId: string): FeedEntryInput => ({
      userId,
      postId: '00000000-0000-4000-8000-0000000000a1',
      authorId: FOLLOWEE,
      reason: 'post',
      repostedById: null,
      postCreatedAt: '2026-08-25T09:00:00.000Z',
    });

    bus.down = true; // the nightly reset just FLUSHALL'd / Valkey is restarting
    await expect(service.upsertEntries([input(OWNER), input(FOLLOWEE)])).resolves.toEqual({
      inserted: 2,
    });
    expect(rows).toHaveLength(2); // the write path never saw the outage

    bus.down = false;
    await expect(service.upsertEntries([input(STRANGER)])).resolves.toEqual({ inserted: 1 });
    expect(bus.deliveries.map((d) => d.channel)).toEqual([feedChannel(STRANGER)]);
  });
});
