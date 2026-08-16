import { describe, expect, it, vi } from 'vitest';
import { SocialService } from './social.service.js';
import type { SocialEvents } from './social-events.js';
import type { SocialRepository } from './social.repository.js';

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';

function fakeRepo(overrides: Partial<SocialRepository> = {}) {
  const profiles = new Map<
    string,
    { id: string; username: string; displayName: string; bio: string | null }
  >();
  const follows = new Set<string>(); // `${follower}->${followee}`
  const blocks = new Set<string>(); // `${blocker}|>${blocked}`
  const repo = {
    findProfile: (id: string) => Promise.resolve(profiles.get(id) ?? null),
    findProfileByUsername: (username: string) =>
      Promise.resolve([...profiles.values()].find((p) => p.username === username) ?? null),
    createProfile: (data: {
      id: string;
      username: string;
      displayName: string;
      bio: string | null;
    }) => {
      profiles.set(data.id, data);
      return Promise.resolve(data);
    },
    updateProfile: (id: string, data: { displayName?: string; bio?: string | null }) => {
      const current = profiles.get(id)!;
      profiles.set(id, { ...current, ...data });
      return Promise.resolve(profiles.get(id)!);
    },
    findFollow: (followerId: string, followeeId: string) =>
      Promise.resolve(
        follows.has(`${followerId}->${followeeId}`) ? { id: 'f', createdAt: new Date() } : null,
      ),
    createFollow: (followerId: string, followeeId: string) => {
      const key = `${followerId}->${followeeId}`;
      if (follows.has(key)) return Promise.resolve(false);
      follows.add(key);
      return Promise.resolve(true);
    },
    deleteFollow: (followerId: string, followeeId: string) =>
      Promise.resolve(follows.delete(`${followerId}->${followeeId}`)),
    findBlock: (blockerId: string, blockedId: string) =>
      Promise.resolve(
        blocks.has(`${blockerId}|>${blockedId}`) ? { id: 'b', createdAt: new Date() } : null,
      ),
    createBlock: (blockerId: string, blockedId: string) => {
      const key = `${blockerId}|>${blockedId}`;
      if (blocks.has(key)) return Promise.resolve(false);
      blocks.add(key);
      return Promise.resolve(true);
    },
    deleteBlock: (blockerId: string, blockedId: string) =>
      Promise.resolve(blocks.delete(`${blockerId}|>${blockedId}`)),
    deleteFollowsBetween: (a: string, b: string) => {
      let n = 0;
      n += follows.delete(`${a}->${b}`) ? 1 : 0;
      n += follows.delete(`${b}->${a}`) ? 1 : 0;
      return Promise.resolve(n);
    },
    counts: () => Promise.resolve({ following: 0, followers: 0 }),
    followPage: () => Promise.resolve({ items: [], nextCursor: null }),
    followerIds: () => Promise.resolve([]),
    blockedIds: () => Promise.resolve([]),
    truncate: () => Promise.resolve(),
    toProfile: (row: {
      id: string;
      username: string;
      displayName: string;
      bio: string | null;
    }) => ({
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      bio: row.bio,
      createdAt: new Date().toISOString(),
    }),
    ...overrides,
  } as unknown as SocialRepository;
  return { repo, profiles, follows, blocks };
}

function spyEvents(): SocialEvents & { calls: [string, Record<string, unknown>][] } {
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

describe('SocialService rules', () => {
  it('creates a profile with a generated display name when none is provided', async () => {
    const { repo } = fakeRepo();
    const events = spyEvents();
    const service = new SocialService(repo, events);

    const { profile, created } = await service.ensureProfile({ id: USER_A, username: 'demo1' }, {});
    expect(created).toBe(true);
    expect(profile.username).toBe('demo1');
    expect(profile.displayName).toMatch(/\S+ \S+/); // faker first + last name
  });

  it('is idempotent: an existing profile is returned unchanged', async () => {
    const { repo } = fakeRepo();
    const service = new SocialService(repo, spyEvents());
    await service.ensureProfile({ id: USER_A, username: 'demo1' }, { displayName: 'Demo One' });

    const { profile, created } = await service.ensureProfile({ id: USER_A, username: 'demo1' }, {});
    expect(created).toBe(false);
    expect(profile.displayName).toBe('Demo One');
  });

  it('rejects identity usernames that violate usernameSchema', async () => {
    const { repo } = fakeRepo();
    const service = new SocialService(repo, spyEvents());
    await expect(
      service.ensureProfile({ id: USER_A, username: 'Not Valid!' }, {}),
    ).rejects.toMatchObject({
      response: { error: { code: 'VALIDATION_ERROR' } },
    });
  });

  it('rejects self-follow, self-block, and unknown targets', async () => {
    const { repo } = fakeRepo();
    const service = new SocialService(repo, spyEvents());
    await service.ensureProfile({ id: USER_A, username: 'demo1' }, {});

    await expect(service.follow(USER_A, USER_A)).rejects.toMatchObject({
      response: { error: { code: 'VALIDATION_ERROR' } },
    });
    await expect(service.block(USER_A, USER_A)).rejects.toMatchObject({
      response: { error: { code: 'VALIDATION_ERROR' } },
    });
    await expect(service.follow(USER_A, USER_B)).rejects.toMatchObject({
      response: { error: { code: 'NOT_FOUND' } },
    });
  });

  it('emits follow.created only on the real transition', async () => {
    const { repo } = fakeRepo();
    const events = spyEvents();
    const service = new SocialService(repo, events);
    await service.ensureProfile({ id: USER_A, username: 'demo1' }, {});
    await service.ensureProfile({ id: USER_B, username: 'demo2' }, {});

    await service.follow(USER_A, USER_B);
    await service.follow(USER_A, USER_B); // idempotent no-op

    expect(events.calls.filter(([type]) => type === 'social.follow.created')).toHaveLength(1);
  });

  it('rejects follows when a block exists in either direction', async () => {
    const { repo } = fakeRepo();
    const service = new SocialService(repo, spyEvents());
    await service.ensureProfile({ id: USER_A, username: 'demo1' }, {});
    await service.ensureProfile({ id: USER_B, username: 'demo2' }, {});
    await service.block(USER_A, USER_B);

    await expect(service.follow(USER_A, USER_B)).rejects.toMatchObject({
      response: { error: { code: 'FORBIDDEN' } },
    });
    // The blocked user cannot follow back either.
    await expect(service.follow(USER_B, USER_A)).rejects.toMatchObject({
      response: { error: { code: 'FORBIDDEN' } },
    });
  });

  it('blocking removes follows in both directions and emits their deletions', async () => {
    const { repo, follows } = fakeRepo();
    const events = spyEvents();
    const service = new SocialService(repo, events);
    await service.ensureProfile({ id: USER_A, username: 'demo1' }, {});
    await service.ensureProfile({ id: USER_B, username: 'demo2' }, {});
    await service.follow(USER_A, USER_B);
    await service.follow(USER_B, USER_A);
    events.calls.length = 0;

    await service.block(USER_A, USER_B);

    expect(follows.size).toBe(0);
    const deleted = events.calls.filter(([type]) => type === 'social.follow.deleted');
    expect(deleted).toHaveLength(2);
    expect(events.calls.some(([type]) => type === 'social.block.created')).toBe(true);
  });

  it('emits profile.updated on PATCH with the new snapshot', async () => {
    const { repo } = fakeRepo();
    const events = spyEvents();
    const service = new SocialService(repo, events);
    await service.ensureProfile({ id: USER_A, username: 'demo1' }, { displayName: 'Demo One' });

    const updated = await service.updateProfile(USER_A, USER_A, { bio: 'demo account' });
    expect(updated.bio).toBe('demo account');
    const [type, payload] = events.calls.at(-1)!;
    expect(type).toBe('social.profile.updated');
    expect(payload).toMatchObject({ profileId: USER_A, username: 'demo1', bio: 'demo account' });
  });

  it('only allows editing your own profile', async () => {
    const { repo } = fakeRepo();
    const service = new SocialService(repo, spyEvents());
    await service.ensureProfile({ id: USER_A, username: 'demo1' }, {});
    await service.ensureProfile({ id: USER_B, username: 'demo2' }, {});

    await expect(service.updateProfile(USER_A, USER_B, { bio: 'hijack' })).rejects.toMatchObject({
      response: { error: { code: 'FORBIDDEN' } },
    });
  });

  it('a failed event emission never fails the committed mutation', async () => {
    const { repo } = fakeRepo();
    const failing: SocialEvents = {
      emit: vi.fn().mockRejectedValue(new Error('kafka down')),
      shutdown: () => Promise.resolve(),
    };
    const service = new SocialService(repo, failing);
    await service.ensureProfile({ id: USER_A, username: 'demo1' }, {});
    await service.ensureProfile({ id: USER_B, username: 'demo2' }, {});

    await expect(service.follow(USER_A, USER_B)).resolves.toBeUndefined();
  });
});
