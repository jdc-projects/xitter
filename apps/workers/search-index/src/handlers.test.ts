import { describe, expect, it, vi, type Mock } from 'vitest';
import type { EachMessagePayload } from 'kafkajs';
import type { Profile, SearchIndexDocument } from '@xitter/api-contracts';
import { EVENT_TYPES } from '@xitter/events';
import {
  chunks,
  collectBatch,
  handleBatch,
  handleEvent,
  type BatchEvent,
  type HandlerDeps,
  type SearchApi,
  type SocialApi,
} from './handlers.js';

const AUTHOR = '00000000-0000-4000-8000-00000000a001';
const OTHER = '00000000-0000-4000-8000-00000000b002';
const NOW = '2026-08-19T09:00:00.000Z';
const EVENT_ID = '11111111-2222-4333-8444-555555555555';
const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`;

function rawFor(topic: string, partition: number, offset: number): EachMessagePayload {
  return {
    topic,
    partition,
    message: { offset: String(offset), value: Buffer.from('{}') },
    heartbeat: async () => undefined,
  } as unknown as EachMessagePayload;
}

const profile = (id: string, displayName: string): Profile => ({
  id,
  username: `user${id.slice(-4)}`,
  displayName,
  bio: null,
  createdAt: NOW,
});

function deps(): HandlerDeps & {
  upsert: Mock<(documents: SearchIndexDocument[]) => Promise<{ indexed: number }>>;
  refresh: Mock<
    (authors: { authorId: string; authorName: string }[]) => Promise<{ updated: number }>
  >;
  checkpoint: Mock<
    (input: {
      consumerKey: string;
      topicPartition: string;
      offset: number;
      eventId: string;
      eventAt: string;
    }) => Promise<void>
  >;
  profiles: Mock<(userIds: string[]) => Promise<{ items: Profile[] }>>;
} {
  const upsert = vi.fn((_documents: SearchIndexDocument[]): Promise<{ indexed: number }> =>
    Promise.resolve({ indexed: 1 }),
  );
  const refresh = vi.fn(
    (_authors: { authorId: string; authorName: string }[]): Promise<{ updated: number }> =>
      Promise.resolve({ updated: 0 }),
  );
  const checkpoint = vi.fn((): Promise<void> => Promise.resolve());
  const profiles = vi.fn((userIds: string[]): Promise<{ items: Profile[] }> =>
    Promise.resolve({ items: userIds.map((id) => profile(id, `Name ${id.slice(-4)}`)) }),
  );
  const search = {
    internalUpsertDocuments: upsert,
    internalRefreshAuthors: refresh,
    internalPutCheckpoint: checkpoint,
  } as unknown as SearchApi;
  const social = { internalProfiles: profiles } as unknown as SocialApi;
  return { search, social, consumerKey: 'test-consumer', upsert, refresh, checkpoint, profiles };
}

function created(postId: string, authorId = AUTHOR, text = 'hello #world'): BatchEvent {
  return {
    envelope: {
      eventId: EVENT_ID,
      eventType: EVENT_TYPES.postCreated,
      eventVersion: 1,
      producer: 'posts',
      occurredAt: NOW,
      payload: {
        postId,
        authorId,
        text,
        mediaIds: [],
        replyToId: null,
        repostOfId: null,
        createdAt: NOW,
      },
    },
    raw: rawFor('xitter.posts.v1', 0, 4),
  };
}

function deleted(postId: string, offset: number): BatchEvent {
  return {
    envelope: {
      eventId: EVENT_ID,
      eventType: EVENT_TYPES.postDeleted,
      eventVersion: 1,
      producer: 'posts',
      occurredAt: NOW,
      payload: { postId, authorId: AUTHOR, deletedAt: NOW },
    },
    raw: rawFor('xitter.posts.v1', 0, offset),
  };
}

function renamed(displayName: string, offset: number, profileId = AUTHOR): BatchEvent {
  return {
    envelope: {
      eventId: EVENT_ID,
      eventType: EVENT_TYPES.profileUpdated,
      eventVersion: 1,
      producer: 'social',
      occurredAt: NOW,
      payload: {
        profileId,
        username: 'demo1',
        displayName,
        bio: null,
        updatedAt: NOW,
      },
    },
    raw: rawFor('xitter.social.v1', 0, offset),
  };
}

describe('search-index handleBatch (accumulate -> flush -> checkpoint)', () => {
  it('batches multiple posts into ONE bulk upsert and ONE checkpoint at the last offset', async () => {
    const d = deps();
    const events = [created(uid('e001')), created(uid('e002'), OTHER), created(uid('e003'))];
    // Distinct offsets so the checkpoint target is unambiguous.
    events[1]!.raw = rawFor('xitter.posts.v1', 0, 5);
    events[2]!.raw = rawFor('xitter.posts.v1', 0, 6);
    await handleBatch(events, { topic: 'xitter.posts.v1', partition: 0 }, d);

    // One bulk with all three docs, hydrated names, keywords extracted.
    expect(d.upsert).toHaveBeenCalledTimes(1);
    const docs = d.upsert.mock.calls[0]![0];
    expect(docs.map((doc: SearchIndexDocument) => doc.postId)).toEqual([
      uid('e001'),
      uid('e002'),
      uid('e003'),
    ]);
    expect(docs[0]!.authorName).toBe(`Name ${AUTHOR.slice(-4)}`);
    expect(docs[0]!.keywords).toEqual(['world']);
    expect(docs.every((doc: SearchIndexDocument) => doc.deletedAt === null)).toBe(true);

    // One author-name lookup for the whole batch (unique ids, single call).
    expect(d.profiles).toHaveBeenCalledTimes(1);
    expect(d.profiles).toHaveBeenCalledWith([AUTHOR, OTHER]);

    // Checkpoint only after the flush: last event's offset, once.
    expect(d.checkpoint).toHaveBeenCalledTimes(1);
    expect(d.checkpoint).toHaveBeenCalledWith({
      consumerKey: 'test-consumer',
      topicPartition: 'xitter.posts.v1:0',
      offset: 6,
      eventId: EVENT_ID,
      eventAt: NOW,
    });
  });

  it('collapses a create followed by a delete of the same post into the tombstone', async () => {
    const d = deps();
    const events = [created(uid('e004')), deleted(uid('e004'), 5)];
    events[0]!.raw = rawFor('xitter.posts.v1', 0, 4);
    await handleBatch(events, { topic: 'xitter.posts.v1', partition: 0 }, d);

    expect(d.upsert).toHaveBeenCalledTimes(1);
    const doc = d.upsert.mock.calls[0]![0][0]!;
    expect(doc.postId).toBe(uid('e004'));
    expect(doc.deletedAt).toBe(NOW);
    expect(doc.text).toBe('');
    // The deleted post needs no author lookup.
    expect(d.profiles).not.toHaveBeenCalled();
    expect(d.checkpoint).toHaveBeenCalledWith(expect.objectContaining({ offset: 5 }));
  });

  it('runs renames after the upserts, deduped last-wins', async () => {
    const d = deps();
    const order: string[] = [];
    const recordUpsert = async (): Promise<{ indexed: number }> => {
      order.push('upsert');
      return { indexed: 1 };
    };
    const recordRefresh = async (): Promise<{ updated: number }> => {
      order.push('refresh');
      return { updated: 0 };
    };
    d.upsert.mockImplementation(recordUpsert);
    d.refresh.mockImplementation(recordRefresh);
    const events = [created(uid('e005')), renamed('First Rename', 5), renamed('Final Name', 6)];
    events[0]!.raw = rawFor('xitter.posts.v1', 0, 4);
    await handleBatch(events, { topic: 'xitter.posts.v1', partition: 0 }, d);

    expect(order).toEqual(['upsert', 'refresh']);
    expect(d.refresh).toHaveBeenCalledTimes(1);
    expect(d.refresh).toHaveBeenCalledWith([{ authorId: AUTHOR, authorName: 'Final Name' }]);
  });

  it('indexes a placeholder name when the profile is missing (bootstrap race)', async () => {
    const d = deps();
    d.profiles.mockResolvedValue({ items: [] });
    await handleBatch([created(uid('e006'))], { topic: 'xitter.posts.v1', partition: 0 }, d);

    expect(d.upsert.mock.calls[0]![0][0]!.authorName).toBe('Unknown');
  });

  it('indexes placeholders for the whole batch when social is down (search never waits)', async () => {
    const d = deps();
    d.profiles.mockRejectedValue(new Error('social down'));
    await handleBatch(
      [created(uid('e007')), created(uid('e008'))],
      { topic: 'xitter.posts.v1', partition: 0 },
      d,
    );

    const docs = d.upsert.mock.calls[0]![0];
    expect(docs.every((doc: SearchIndexDocument) => doc.authorName === 'Unknown')).toBe(true);
  });

  it('checkpoints non-actionable events too (no replays after group loss)', async () => {
    const d = deps();
    await handleBatch(
      [
        {
          envelope: {
            eventId: EVENT_ID,
            eventType: EVENT_TYPES.interactionCreated,
            eventVersion: 1,
            producer: 'posts',
            occurredAt: NOW,
            payload: { kind: 'like', postId: uid('e009'), userId: AUTHOR, createdAt: NOW },
          },
          raw: rawFor('xitter.posts.v1', 0, 7),
        },
      ],
      { topic: 'xitter.posts.v1', partition: 0 },
      d,
    );

    expect(d.upsert).not.toHaveBeenCalled();
    expect(d.refresh).not.toHaveBeenCalled();
    expect(d.checkpoint).toHaveBeenCalledTimes(1);
  });

  it('skips payloads that fail schema validation (poison-safe) but still checkpoints', async () => {
    const d = deps();
    await handleBatch(
      [
        {
          envelope: {
            eventId: EVENT_ID,
            eventType: EVENT_TYPES.postCreated,
            eventVersion: 1,
            producer: 'posts',
            occurredAt: NOW,
            payload: { postId: 'not-a-uuid' },
          },
          raw: rawFor('xitter.posts.v1', 0, 3),
        },
      ],
      { topic: 'xitter.posts.v1', partition: 0 },
      d,
    );

    expect(d.upsert).not.toHaveBeenCalled();
    // Even a poison message advances the checkpoint (log + skip).
    expect(d.checkpoint).toHaveBeenCalledTimes(1);
  });

  it('propagates upsert failures so neither checkpoint nor offsets advance', async () => {
    const d = deps();
    d.upsert.mockRejectedValue(new Error('search down'));
    await expect(
      handleBatch(
        [created(uid('e010')), created(uid('e011'))],
        { topic: 'xitter.posts.v1', partition: 0 },
        d,
      ),
    ).rejects.toThrow('search down');
    // The failed batch must NOT checkpoint - a wiped group would otherwise
    // resume past unprocessed work (whole-batch redelivery is the contract).
    expect(d.checkpoint).not.toHaveBeenCalled();
  });

  it('propagates rename failures so neither checkpoint nor offsets advance', async () => {
    const d = deps();
    d.refresh.mockRejectedValue(new Error('rename failed'));
    await expect(
      handleBatch([renamed('Nope', 2)], { topic: 'xitter.social.v1', partition: 0 }, d),
    ).rejects.toThrow('rename failed');
    expect(d.checkpoint).not.toHaveBeenCalled();
  });

  it('splits oversized batches into contract-sized chunks, sequentially', async () => {
    const d = deps();
    const seen: number[] = [];
    const recordSizes = async (docs: SearchIndexDocument[]): Promise<{ indexed: number }> => {
      seen.push(docs.length);
      return { indexed: docs.length };
    };
    d.upsert.mockImplementation(recordSizes);
    const events = Array.from({ length: 1001 }, (_, i) => {
      const event = created(uid(String(i).padStart(3, '0')));
      event.raw = rawFor('xitter.posts.v1', 0, i);
      return event;
    });
    await handleBatch(events, { topic: 'xitter.posts.v1', partition: 0 }, d);

    expect(seen).toEqual([1000, 1]);
    expect(d.checkpoint).toHaveBeenCalledWith(expect.objectContaining({ offset: 1000 }));
  });
});

describe('search-index handleEvent (single-event compatibility path)', () => {
  it('still indexes one event with its author name and checkpoint', async () => {
    const d = deps();
    await handleEvent(created(uid('e012')).envelope, rawFor('xitter.posts.v1', 0, 4), d);

    expect(d.profiles).toHaveBeenCalledWith([AUTHOR]);
    const doc = d.upsert.mock.calls[0]![0][0]!;
    expect(doc.postId).toBe(uid('e012'));
    expect(doc.authorName).toBe(`Name ${AUTHOR.slice(-4)}`);
    expect(d.checkpoint).toHaveBeenCalledWith({
      consumerKey: 'test-consumer',
      topicPartition: 'xitter.posts.v1:0',
      offset: 4,
      eventId: EVENT_ID,
      eventAt: NOW,
    });
  });

  it('runs side effects without checkpointing when there is no Kafka context', async () => {
    const d = deps();
    await handleEvent(created(uid('e013')).envelope, undefined, d);

    expect(d.upsert).toHaveBeenCalledTimes(1);
    expect(d.checkpoint).not.toHaveBeenCalled();
  });
});

describe('collectBatch (pure accumulation)', () => {
  it('keeps per-partition checkpoint candidates and unique author ids in order', () => {
    const events = [
      { ...created(uid('e014')), raw: rawFor('xitter.posts.v1', 1, 10) },
      { ...created(uid('e015'), OTHER), raw: rawFor('xitter.posts.v1', 1, 11) },
      { ...created(uid('e016')), raw: rawFor('xitter.posts.v1', 1, 12) }, // same author as first
    ];
    const batch = collectBatch(events);
    expect(batch.authorIds).toEqual([AUTHOR, OTHER]);
    expect(batch.documents).toHaveLength(3);
    expect(batch.last).toMatchObject({ offset: 12, eventId: EVENT_ID, eventAt: NOW });
    // Tombstone names are decided at flush; nothing to resolve for them.
    expect(batch.renames.size).toBe(0);
  });

  it('an all-noise batch still produces a checkpoint candidate and no documents', () => {
    const batch = collectBatch([
      {
        envelope: {
          eventId: EVENT_ID,
          eventType: EVENT_TYPES.followCreated,
          eventVersion: 1,
          producer: 'social',
          occurredAt: NOW,
          payload: { followerId: AUTHOR, followeeId: OTHER, createdAt: NOW },
        },
        raw: rawFor('xitter.social.v1', 0, 42),
      },
    ]);
    expect(batch.documents).toEqual([]);
    expect(batch.last).toMatchObject({ offset: 42 });
  });
});

describe('chunks', () => {
  it('splits preserving order at the boundary', () => {
    expect(chunks([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(chunks([1, 2], 2)).toEqual([[1, 2]]);
    expect(chunks([], 2)).toEqual([]);
  });
});
