import { describe, expect, it } from 'vitest';
import {
  deriveNextVersion,
  formatSemVer,
  parseConventionalCommit,
  parseSemVer,
  renderNotes,
  type ConventionalCommit,
} from './release-version.js';

function commit(subject: string, body = '', hash = 'abc1234'): ConventionalCommit {
  return { hash, subject, body };
}

describe('parseSemVer', () => {
  it('parses major/minor/patch with optional v prefix and prerelease', () => {
    expect(parseSemVer('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
    expect(parseSemVer('0.11.0')).toEqual({ major: 0, minor: 11, patch: 0, prerelease: null });
    expect(parseSemVer('v1.0.0-rc.1')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: 'rc.1',
    });
  });

  it('rejects non-semver tags', () => {
    expect(parseSemVer('dev')).toBeNull();
    expect(parseSemVer('sha-abc1234')).toBeNull();
    expect(parseSemVer('v1.2')).toBeNull();
  });
});

describe('parseConventionalCommit', () => {
  it('parses type, scope, and description', () => {
    expect(parseConventionalCommit(commit('feat(feed): realtime fanout'))).toMatchObject({
      type: 'feat',
      scope: 'feed',
      breaking: false,
      description: 'realtime fanout',
    });
    expect(parseConventionalCommit(commit('fix: login redirect'))).toMatchObject({
      type: 'fix',
      scope: null,
      description: 'login redirect',
    });
  });

  it('marks breaking via ! and via BREAKING CHANGE footer', () => {
    expect(parseConventionalCommit(commit('feat(api)!: rename field'))?.breaking).toBe(true);
    expect(
      parseConventionalCommit(commit('fix: thing', 'BREAKING CHANGE: dropped v0 endpoints'))
        ?.breaking,
    ).toBe(true);
    expect(parseConventionalCommit(commit('fix: thing', 'some unrelated body'))?.breaking).toBe(
      false,
    );
  });

  it('returns null for non-conventional subjects (merges, reverts-in-prose)', () => {
    expect(parseConventionalCommit(commit('Merge branch release/v1 into prod'))).toBeNull();
    expect(parseConventionalCommit(commit('Update README'))).toBeNull();
  });
});

describe('deriveNextVersion', () => {
  it('first release is 0.1.0 (feature-complete initial promotion)', () => {
    expect(formatSemVer(deriveNextVersion([], null))).toBe('v0.1.0');
  });

  it('feat bumps minor, fix/perf bump patch', () => {
    const prev = parseSemVer('v0.1.0')!;
    expect(formatSemVer(deriveNextVersion([commit('feat(x): new')], prev))).toBe('v0.2.0');
    expect(
      formatSemVer(deriveNextVersion([commit('fix(x): bug'), commit('perf(x): faster')], prev)),
    ).toBe('v0.1.1');
  });

  it('breaking bumps minor while major is 0, major after', () => {
    expect(
      formatSemVer(deriveNextVersion([commit('feat(x)!: break')], parseSemVer('v0.4.2')!)),
    ).toBe('v0.5.0');
    expect(
      formatSemVer(deriveNextVersion([commit('feat(x)!: break')], parseSemVer('v1.4.2')!)),
    ).toBe('v2.0.0');
  });

  it('non-user-facing commits alone still produce a patch release', () => {
    expect(formatSemVer(deriveNextVersion([commit('chore: deps')], parseSemVer('v1.0.0')!))).toBe(
      'v1.0.1',
    );
    expect(formatSemVer(deriveNextVersion([], parseSemVer('v1.0.0')!))).toBe('v1.0.1');
  });

  it('breaking beats feat when both present', () => {
    const commits = [commit('fix: a'), commit('feat: b'), commit('chore(scope)!: c')];
    expect(formatSemVer(deriveNextVersion(commits, parseSemVer('v1.2.3')!))).toBe('v2.0.0');
  });

  it('ignores non-conventional commits entirely', () => {
    expect(
      formatSemVer(deriveNextVersion([commit('Merge pull request #12')], parseSemVer('v0.1.0')!)),
    ).toBe('v0.1.1');
  });
});

describe('renderNotes', () => {
  it('groups breaking, features, fixes, internal, and links the compare range', () => {
    const notes = renderNotes(parseSemVer('v0.2.0')!, 'v0.1.0', [
      commit('feat(feed): realtime fanout', '', 'aaaa111'),
      commit('fix(web): 404 branding', '', 'bbbb222'),
      commit('chore(ci): bump actions', '', 'cccc333'),
      commit('feat(api)!: drop legacy field', '', 'dddd444'),
    ]);
    expect(notes).toContain('## v0.2.0');
    expect(notes).toContain('v0.1.0...v0.2.0');
    expect(notes).toContain('### Breaking changes');
    expect(notes).toContain('drop legacy field (dddd444)');
    expect(notes).toContain('### Features');
    expect(notes).toContain('**feed:** realtime fanout (aaaa111)');
    expect(notes).toContain('### Fixes');
    expect(notes).toContain('**web:** 404 branding (bbbb222)');
    expect(notes).toContain('### Internal');
    expect(notes).toContain('bump actions (cccc333)');
  });

  it('omits empty sections and handles the initial release', () => {
    const notes = renderNotes(parseSemVer('v0.1.0')!, null, [
      commit('feat: everything', '', 'aaaa111'),
    ]);
    expect(notes).toContain('Initial release.');
    expect(notes).not.toContain('### Fixes');
    expect(notes).not.toContain('### Breaking changes');
  });
});
