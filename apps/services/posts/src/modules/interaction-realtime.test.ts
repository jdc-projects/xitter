import { describe, expect, it } from 'vitest';
import { feedUpdatesChannel } from '@xitter/api-contracts';
import type { InteractionKind } from '@xitter/api-contracts';
import { NullMediaChecker } from './media-checker.js';
import type { MediaChecker } from './media-checker.js';
import { PostsService } from './posts.service.js';
import type { PostsEvents } from './posts-events.js';
import type { PostsRepository, PostRow, InteractionRow } from './posts.repository.js';
import type { RelationshipChecker } from './relationship-checker.js';
import { ValkeyInteractionRealtime } from './interaction-realtime.js';

const AUTHOR = '00000000-0000-4000-8000-0000000000a1';
const READER = '00000000-0000-4000-8000-0000000000b2';

type PmessageListener = (pattern: string, channel: string, message: string) => void;

/**
 * In-memory Valkey pub/sub with real routing semantics (the #119 lesson:
 * bare vi.fn() doubles model error shapes a live broker never emits).
 * Publisher connections fan every publish out to pattern subscribers whose
 * glob pattern matches the channel, invoking the ioredis `pmessage`
 * contract. `down`/`failPublish`/`failQuit` script outages.
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
    /** Publisher connection (ValkeyInteractionRealtime's structural slice). */
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
    /** Subscriber standing in for the feed gateway's pattern subscription. */
    subscriber(pattern: string): { patterns: string[] } {
      const state = { patterns: [pattern], listeners: [] as PmessageListener[] };
      subscribers.push(state);
      return { patterns: state.patterns };
    },
  };
  return bus;
}

const realtimeOver = (bus: ReturnType<typeof fakeValkeyBus>) =>
  new ValkeyInteractionRealtime('redis://valkey:6379', () => bus.connect());

describe('ValkeyInteractionRealtime author ping (contract)', () => {
  it('publishes the ping on the api-contracts feed channel', async () => {
    const bus = fakeValkeyBus();
    const feedGateway = bus.subscriber('feed:updates:*'); // what feed subscribes
    const realtime = realtimeOver(bus);

    await realtime.notifyAuthor(AUTHOR);

    expect(feedGateway.patterns).toEqual(['feed:updates:*']);
    expect(bus.deliveries).toEqual([
      { pattern: 'feed:updates:*', channel: feedUpdatesChannel(AUTHOR), message: '1' },
    ]);
  });

  it('reuses one lazily-created connection across pings', async () => {
    const bus = fakeValkeyBus();
    const realtime = realtimeOver(bus);
    bus.subscriber('feed:updates:*');

    await realtime.notifyAuthor(AUTHOR);
    await realtime.notifyAuthor(READER);
    await realtime.notifyAuthor(AUTHOR);

    expect(bus.connectCount).toBe(1);
    expect(bus.deliveries).toHaveLength(3);
  });
});

describe('ValkeyInteractionRealtime best-effort semantics (ping never fails the interaction)', () => {
  it('resolves - never rejects - while Valkey is unreachable', async () => {
    const bus = fakeValkeyBus();
    bus.down = true;

    await expect(realtimeOver(bus).notifyAuthor(AUTHOR)).resolves.toBeUndefined();
  });

  it('resolves when a publish on a live connection fails', async () => {
    const bus = fakeValkeyBus();
    const realtime = realtimeOver(bus);
    await realtime.notifyAuthor(AUTHOR); // healthy first ping

    bus.failPublish = true;
    await expect(realtime.notifyAuthor(AUTHOR)).resolves.toBeUndefined();
  });

  it('drops the dead connection (quit) and reconnects on the next ping', async () => {
    const bus = fakeValkeyBus();
    const realtime = realtimeOver(bus);
    bus.subscriber('feed:updates:*');
    await realtime.notifyAuthor(AUTHOR);

    bus.failPublish = true;
    await realtime.notifyAuthor(AUTHOR); // fails; the dead handle is dropped
    bus.failPublish = false;
    await realtime.notifyAuthor(AUTHOR); // reconnects

    expect(bus.connectCount).toBe(2); // not 3: the outage dropped, not kept, the handle
    expect(bus.connections[0]!.quits).toBe(1); // the dead connection was released
    expect(bus.deliveries).toHaveLength(2); // first and recovered ping both landed
  });

  it('an outage-and-recover cycle creates exactly one connection, not one per ping', async () => {
    const bus = fakeValkeyBus();
    const realtime = realtimeOver(bus);
    bus.subscriber('feed:updates:*');

    bus.down = true;
    await realtime.notifyAuthor(AUTHOR);
    await realtime.notifyAuthor(AUTHOR);
    await realtime.notifyAuthor(AUTHOR);

    bus.down = false;
    await realtime.notifyAuthor(AUTHOR);

    expect(bus.connectCount).toBe(1); // only the recovered, working connection
    expect(bus.deliveries).toHaveLength(1);
  });
});

describe('ValkeyInteractionRealtime stop (shutdown leak-safety)', () => {
  it('releases the live connection', async () => {
    const bus = fakeValkeyBus();
    const realtime = realtimeOver(bus);
    await realtime.notifyAuthor(AUTHOR);

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
    await realtime.notifyAuthor(AUTHOR);

    bus.failQuit = true;
    await expect(realtime.stop()).resolves.toBeUndefined();
  });
});

const postRow = (): PostRow => ({
  id: '00000000-0000-4000-8000-0000000000a01',
  authorId: AUTHOR,
  text: 'hello xitter',
  mediaIds: [],
  media: [],
  replyToId: null,
  repostOfId: null,
  createdAt: new Date('2026-08-25T00:00:00Z'),
  deletedAt: null,
  replyCount: 0,
  likeCount: 0,
  repostCount: 0,
});

/** In-memory repo for the interaction paths (natural key: kind|postId|userId). */
function fakeRepo() {
  const post = postRow();
  const interactions = new Map<string, InteractionRow>();
  const key = (kind: string, postId: string, userId: string) => `${kind}|${postId}|${userId}`;
  const repo = {
    interactions,
    findPost: (id: string) => Promise.resolve(id === post.id ? post : null),
    findVisiblePost: (id: string) => Promise.resolve(id === post.id ? post : null),
    createInteraction: (input: { kind: InteractionKind; postId: string; userId: string }) => {
      const existing = interactions.get(key(input.kind, input.postId, input.userId));
      if (existing) return Promise.resolve({ row: existing, created: false });
      const row = {
        id: crypto.randomUUID(),
        kind: input.kind,
        postId: input.postId,
        userId: input.userId,
        createdAt: new Date(),
      } as InteractionRow;
      interactions.set(key(input.kind, input.postId, input.userId), row);
      return Promise.resolve({ row, created: true });
    },
    deleteInteraction: (input: { kind: InteractionKind; postId: string; userId: string }) =>
      Promise.resolve(interactions.delete(key(input.kind, input.postId, input.userId))),
  };
  return { repo: repo as unknown as PostsRepository, interactions, post };
}

function spyEvents(): PostsEvents & { calls: [string, Record<string, unknown>][] } {
  const calls: [string, Record<string, unknown>][] = [];
  return {
    calls,
    emit: (eventType, payload) => {
      calls.push([eventType, payload]);
      return Promise.resolve();
    },
    shutdown: () => Promise.resolve(),
  };
}

const allowAll: RelationshipChecker = { blockedEitherWay: () => Promise.resolve(false) };
const noMedia: MediaChecker = new NullMediaChecker();

/** The real service over the scripted bus - the ping is observed on the wire. */
function serviceOver(bus: ReturnType<typeof fakeValkeyBus>) {
  const { repo, interactions, post } = fakeRepo();
  const events = spyEvents();
  const service = new PostsService(repo, events, allowAll, noMedia, realtimeOver(bus));
  return { service, events, interactions, post };
}

describe('PostsService author-ping privacy (who learns what)', () => {
  it('pings the author for a like and for a repost', async () => {
    const bus = fakeValkeyBus();
    bus.subscriber('feed:updates:*');
    const { service, post } = serviceOver(bus);

    await service.interact(READER, post.id, 'like');
    await service.interact(READER, post.id, 'repost');

    expect(bus.deliveries.map((d) => d.channel)).toEqual([
      feedUpdatesChannel(AUTHOR),
      feedUpdatesChannel(AUTHOR),
    ]);
  });

  it('NEVER pings for a bookmark (the author must not learn who bookmarked)', async () => {
    const bus = fakeValkeyBus();
    bus.subscriber('feed:updates:*');
    const { service, post } = serviceOver(bus);

    await expect(service.interact(READER, post.id, 'bookmark')).resolves.toMatchObject({
      kind: 'bookmark',
      userId: READER,
    });

    expect(bus.deliveries).toEqual([]); // not one byte reaches the author
    expect(bus.connectCount).toBe(0); // no connection is even opened
  });

  it('does not ping the author for her own like or repost (self-ping is noise)', async () => {
    const bus = fakeValkeyBus();
    bus.subscriber('feed:updates:*');
    const { service, post } = serviceOver(bus);

    await service.interact(AUTHOR, post.id, 'like');
    await service.interact(AUTHOR, post.id, 'repost');

    expect(bus.deliveries).toEqual([]);
  });

  it('pings once for a repeated interaction (idempotent creates do not re-ping)', async () => {
    const bus = fakeValkeyBus();
    bus.subscriber('feed:updates:*');
    const { service, post } = serviceOver(bus);

    await service.interact(READER, post.id, 'like');
    await service.interact(READER, post.id, 'like'); // replay: same natural key

    expect(bus.deliveries).toHaveLength(1);
  });

  it('does not ping when an interaction is undone', async () => {
    const bus = fakeValkeyBus();
    bus.subscriber('feed:updates:*');
    const { service, post } = serviceOver(bus);

    await service.interact(READER, post.id, 'like');
    const before = bus.deliveries.length;
    await service.removeInteraction(READER, post.id, 'like');

    expect(bus.deliveries).toHaveLength(before);
  });
});

describe('the interaction commits even when the ping cannot be delivered', () => {
  it('a like against a down Valkey resolves, stores, and emits the event', async () => {
    const bus = fakeValkeyBus();
    bus.subscriber('feed:updates:*');
    const { service, events, interactions, post } = serviceOver(bus);

    bus.down = true; // Valkey is unreachable at interaction time
    await expect(service.interact(READER, post.id, 'like')).resolves.toMatchObject({
      kind: 'like',
      postId: post.id,
      userId: READER,
    });

    expect(interactions.size).toBe(1); // the write path never saw the outage
    expect(events.calls.map(([type]) => type)).toEqual(['posts.interaction.created']);
  });

  it('recovers without leaking connections: one ping lands after the outage', async () => {
    const bus = fakeValkeyBus();
    bus.subscriber('feed:updates:*');
    const { service, post } = serviceOver(bus);

    bus.failPublish = true; // connected, but the broker just restarted
    await service.interact(READER, post.id, 'like');
    bus.failPublish = false;
    await service.interact(READER, post.id, 'repost');

    expect(bus.deliveries).toEqual([
      { pattern: 'feed:updates:*', channel: feedUpdatesChannel(AUTHOR), message: '1' },
    ]); // only the recovered repost ping - the lost like ping is a refetch away
    expect(bus.connectCount).toBe(2); // dead handle dropped, exactly one reconnect
  });
});
