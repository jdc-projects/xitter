import { describe, expect, it } from 'vitest';
import type { Relationship } from '@xitter/api-contracts';
import { profileViewState } from './view-model';

const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

const rel = (overrides: Partial<Relationship> = {}): Relationship => ({
  following: false,
  followedBy: false,
  blocking: false,
  blockedBy: false,
  ...overrides,
});

describe('profileViewState', () => {
  it('own profile: edit only, no badges, no follow/block', () => {
    const state = profileViewState(ME, { id: ME }, rel({ following: true }));
    expect(state).toEqual({
      isOwnProfile: true,
      badges: [],
      primaryAction: null,
      canBlock: false,
      blocking: false,
    });
  });

  it('stranger: follow offered, no badges', () => {
    expect(profileViewState(ME, { id: OTHER }, rel())).toMatchObject({
      isOwnProfile: false,
      badges: [],
      primaryAction: 'follow',
      canBlock: true,
      blocking: false,
    });
  });

  it('following: unfollow offered', () => {
    expect(profileViewState(ME, { id: OTHER }, rel({ following: true })).primaryAction).toBe(
      'unfollow',
    );
  });

  it('they follow me: "Follows you" badge', () => {
    const state = profileViewState(ME, { id: OTHER }, rel({ followedBy: true }));
    expect(state.badges).toEqual([{ testId: 'badge-follows-you', label: 'Follows you' }]);
  });

  it('I blocked them: "Blocked" badge and follow is unavailable', () => {
    const state = profileViewState(ME, { id: OTHER }, rel({ blocking: true, following: false }));
    expect(state.badges).toEqual([{ testId: 'badge-blocked', label: 'Blocked' }]);
    expect(state.primaryAction).toBeNull();
    expect(state.blocking).toBe(true);
  });

  it('they blocked me: "Blocked" badge, follow still offered (service rejects it)', () => {
    const state = profileViewState(ME, { id: OTHER }, rel({ blockedBy: true }));
    expect(state.badges).toEqual([{ testId: 'badge-blocked', label: 'Blocked' }]);
    expect(state.primaryAction).toBe('follow');
  });

  it('both badges can appear together', () => {
    const state = profileViewState(ME, { id: OTHER }, rel({ followedBy: true, blocking: true }));
    expect(state.badges.map((b) => b.testId)).toEqual(['badge-follows-you', 'badge-blocked']);
  });
});
