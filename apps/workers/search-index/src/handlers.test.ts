import { describe, expect, it, vi } from 'vitest';
import type { EachMessagePayload } from 'kafkajs';
import type { Profile, SearchIndexDocument } from '@xitter/api-contracts';
import { EVENT_TYPES } from '@xitter/events';
import { handleEvent, type HandlerDeps, type SearchApi, type SocialApi } from './handlers.js';

const AUTHOR = '00000000-0000-4000-8000-00000000a001';
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
  upsert: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  checkpoint: ReturnType<typeof vi.fn>;
  profiles: ReturnType<typeof vi.fn>;
} {
  const upsert = vi.fn((_documents: SearchIndexDocument[]) => Promise.resolve({ indexed: 1 }));
  const refresh = vi.fn((_authors: { authorId: string; authorName: string }[]) =>
    Promise.resolve({ updated: 0 }),
  );
  const checkpoint = vi.fn(() => Promise.resolve());
  const profiles = vi.fn((userIds: string[]) =>
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

describe('search-index handleEvent', () => {
  it('indexes posts.post.created with the author display name', async () => {
    const d = deps();
    await handleEvent(
      {
        eventId: EVENT_ID,
        eventType: EVENT_TYPES.postCreated,
        eventVersion: 1,
        producer: 'posts',
        occurredAt: NOW,
        payload: {
          postId: uid('e001'),
          authorId: AUTHOR,
          text: 'hello #world',
          mediaIds: [],
          replyToId: null,
          repostOfId: null,
          createdAt: NOW,
        },
      },
      rawFor('xitter.posts.v1', 0, 4),
      d,
    );

    expect(d.profiles).toHaveBeenCalledWith([AUTHOR]);
    const doc = d.upsert.mock.calls[0]![0][0]!;
    expect(doc.postId).toBe(uid('e001'));
    expect(doc.authorName).toBe(`Name ${AUTHOR.slice(-4)}`);
    expect(doc.keywords).toEqual(['world']);
    expect(doc.deletedAt).toBeNull();
    // Checkpoint written after the side effect: resume at offset 5.
    expect(d.checkpoint).toHaveBeenCalledWith({
      consumerKey: 'test-consumer',
      topicPartition: 'xitter.posts.v1:0',
      offset: 4,
      eventId: EVENT_ID,
      eventAt: NOW,
    });
  });

  it('indexes a placeholder name when the profile is missing (bootstrap race)', async () => {
    const d = deps();
    d.profiles.mockResolvedValue({ items: [] });
    await handleEvent(
      {
        eventId: EVENT_ID,
        eventType: EVENT_TYPES.postCreated,
        eventVersion: 1,
        producer: 'posts',
        occurredAt: NOW,
        payload: {
          postId: uid('e002'),
          authorId: AUTHOR,
          text: 'hi',
          mediaIds: [],
          replyToId: null,
          repostOfId: null,
          createdAt: NOW,
        },
      },
      rawFor('xitter.posts.v1', 0, 1),
      d,
    );

    expect(d.upsert.mock.calls[0]![0][0]!.authorName).toBe('Unknown');
  });

  it('tombstones posts.post.deleted (deletedAt set, empty body)', async () => {
    const d = deps();
    await handleEvent(
      {
        eventId: EVENT_ID,
        eventType: EVENT_TYPES.postDeleted,
        eventVersion: 1,
        producer: 'posts',
        occurredAt: NOW,
        payload: { postId: uid('e003'), authorId: AUTHOR, deletedAt: NOW },
      },
      rawFor('xitter.posts.v1', 1, 9),
      d,
    );

    const doc = d.upsert.mock.calls[0]![0][0]!;
    expect(doc.deletedAt).toBe(NOW);
    expect(doc.text).toBe('');
    expect(d.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({ topicPartition: 'xitter.posts.v1:1', offset: 9 }),
    );
  });

  it('refreshes denormalised names on social.profile.updated', async () => {
    const d = deps();
    await handleEvent(
      {
        eventId: EVENT_ID,
        eventType: EVENT_TYPES.profileUpdated,
        eventVersion: 1,
        producer: 'social',
        occurredAt: NOW,
        payload: {
          profileId: AUTHOR,
          username: 'demo1',
          displayName: 'Renamed',
          bio: null,
          updatedAt: NOW,
        },
      },
      rawFor('xitter.social.v1', 0, 2),
      d,
    );

    expect(d.refresh).toHaveBeenCalledWith([{ authorId: AUTHOR, authorName: 'Renamed' }]);
    expect(d.upsert).not.toHaveBeenCalled();
  });

  it('checkpoints non-actionable events too (no replays after group loss)', async () => {
    const d = deps();
    await handleEvent(
      {
        eventId: EVENT_ID,
        eventType: EVENT_TYPES.interactionCreated,
        eventVersion: 1,
        producer: 'posts',
        occurredAt: NOW,
        payload: { kind: 'like', postId: uid('e004'), userId: AUTHOR, createdAt: NOW },
      },
      rawFor('xitter.posts.v1', 0, 7),
      d,
    );

    expect(d.upsert).not.toHaveBeenCalled();
    expect(d.checkpoint).toHaveBeenCalledTimes(1);
  });

  it('skips payloads that fail schema validation (poison-safe)', async () => {
    const d = deps();
    await handleEvent(
      {
        eventId: EVENT_ID,
        eventType: EVENT_TYPES.postCreated,
        eventVersion: 1,
        producer: 'posts',
        occurredAt: NOW,
        payload: { postId: 'not-a-uuid' },
      },
      rawFor('xitter.posts.v1', 0, 3),
      d,
    );

    expect(d.upsert).not.toHaveBeenCalled();
    // Even a poison message advances the checkpoint (log + skip).
    expect(d.checkpoint).toHaveBeenCalledTimes(1);
  });

  it('propagates index failures so neither checkpoint nor offset advance', async () => {
    const d = deps();
    d.upsert.mockRejectedValueOnce(new Error('search down'));
    await expect(
      handleEvent(
        {
          eventId: EVENT_ID,
          eventType: EVENT_TYPES.postCreated,
          eventVersion: 1,
          producer: 'posts',
          occurredAt: NOW,
          payload: {
            postId: uid('e005'),
            authorId: AUTHOR,
            text: 'x',
            mediaIds: [],
            replyToId: null,
            repostOfId: null,
            createdAt: NOW,
          },
        },
        rawFor('xitter.posts.v1', 0, 5),
        d,
      ),
    ).rejects.toThrow('search down');
    // The failed event must NOT be checkpointed - a wiped group would
    // otherwise skip it forever (resume past unprocessed work).
    expect(d.checkpoint).not.toHaveBeenCalled();
  });
});
