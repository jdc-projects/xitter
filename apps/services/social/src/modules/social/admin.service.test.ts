import { describe, expect, it, vi } from 'vitest';
import { SocialService } from './social.service.js';
import type { SocialEvents } from './social-events.js';
import type { SocialRepository } from './social.repository.js';

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';
const USER_C = '00000000-0000-4000-8000-00000000000c';

interface ProfileRowLike {
  id: string;
  username: string;
  displayName: string;
  bio: string | null;
  createdAt: Date;
}

function makeService() {
  const profiles = new Map<string, ProfileRowLike>([
    [
      USER_A,
      {
        id: USER_A,
        username: 'demo1',
        displayName: 'Demo One',
        bio: null,
        createdAt: new Date('2026-08-16T00:00:00Z'),
      },
    ],
    [
      USER_B,
      {
        id: USER_B,
        username: 'demo2',
        displayName: 'Demo Two',
        bio: 'hello',
        createdAt: new Date('2026-08-16T00:00:00Z'),
      },
    ],
  ]);
  const repo = {
    adminProfiles: vi.fn(() =>
      Promise.resolve({ items: [...profiles.values()], nextCursor: null }),
    ),
    adminProfile: vi.fn((id: string) => Promise.resolve(profiles.get(id) ?? null)),
    counts: vi.fn(() => Promise.resolve({ following: 3, followers: 5 })),
    followPage: vi.fn(
      (mode: 'following' | 'followers', _userId: string, _cursor?: string, _limit?: number) =>
        Promise.resolve({
          items:
            mode === 'followers'
              ? [profiles.get(USER_C) ?? fakeRow(USER_C, 'demo3')]
              : [profiles.get(USER_B)!],
          nextCursor: null,
        }),
    ),
    toProfile: (row: ProfileRowLike) => ({
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      bio: row.bio,
      createdAt: row.createdAt.toISOString(),
    }),
  };
  const service = new SocialService(
    repo as unknown as SocialRepository,
    { emit: vi.fn(), shutdown: vi.fn() } as unknown as SocialEvents,
  );
  return { repo, service };
}

function fakeRow(id: string, username: string): ProfileRowLike {
  return {
    id,
    username,
    displayName: `Row ${username}`,
    bio: null,
    createdAt: new Date('2026-08-16T00:00:00Z'),
  };
}

describe('SocialService admin inspection', () => {
  it('lists users with graph counts', async () => {
    const { service } = makeService();
    const page = await service.adminUsers({ limit: 20 });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({ username: 'demo1', counts: { followers: 5 } });
  });

  it('passes the username filter through', async () => {
    const { repo, service } = makeService();
    await service.adminUsers({ username: 'demo2', limit: 20 });
    expect(repo.adminProfiles).toHaveBeenCalledWith('demo2', undefined, 20);
  });

  it('rejects a malformed cursor with 400', async () => {
    const { service } = makeService();
    await expect(service.adminUsers({ cursor: '%%%', limit: 20 })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('returns the follow graph: profile + counts + both edge directions', async () => {
    const { service } = makeService();
    const graph = await service.adminFollowGraph(USER_A);
    expect(graph.profile).toMatchObject({
      id: USER_A,
      username: 'demo1',
      counts: { following: 3, followers: 5 },
    });
    expect(graph.followers[0]).toMatchObject({ username: 'demo3' });
    expect(graph.following[0]).toMatchObject({ username: 'demo2' });
  });

  it('404s for an unknown user', async () => {
    const { service } = makeService();
    await expect(
      service.adminFollowGraph('00000000-0000-4000-8000-00000000ffff'),
    ).rejects.toMatchObject({ status: 404 });
  });
});
