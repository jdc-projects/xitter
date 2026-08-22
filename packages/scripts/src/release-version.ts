#!/usr/bin/env tsx
/**
 * Release version derivation: `tsx packages/scripts/src/release-version.ts`
 *
 * Derives the next semver release from the conventional-commit history since
 * the last reachable `v*` tag (the Release workflow runs this on merge to
 * `prod`), or accepts an explicit version for dry-runs/repairs. Writes
 * machine-readable outputs for CI and human-readable notes.
 *
 * Bump rules (conventional commits, 0.x-aware - while the major is 0 a
 * breaking change bumps the minor, not the major):
 *   - breaking (`!` or a `BREAKING CHANGE:` footer) -> major (0.x: minor)
 *   - `feat` -> minor (0.x: minor)
 *   - `fix` / `perf` -> patch
 *   - anything else alone -> patch (a release with no user-facing commits
 *     still rolls the deployable forward deterministically)
 *   - no previous tag -> 0.1.0 (the first release promotes a feature-complete
 *     build, hence a minor, not 0.0.1)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from '@xitter/config';

export interface ConventionalCommit {
  hash: string;
  subject: string;
  body: string;
}

export interface ParsedCommit {
  hash: string;
  type: string;
  scope: string | null;
  breaking: boolean;
  description: string;
}

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

const CONVENTIONAL_SUBJECT =
  /^(feat|fix|perf|refactor|docs|test|build|ci|chore|revert|style)(\([^)]*\))?(!)?:\s(.+)$/;

export function parseSemVer(tag: string): SemVer | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(tag);
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  if (!major || !minor || !patch) return null;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ?? null,
  };
}

export function formatSemVer(v: SemVer): string {
  return `v${v.major}.${v.minor}.${v.patch}${v.prerelease ? `-${v.prerelease}` : ''}`;
}

export function parseConventionalCommit(commit: ConventionalCommit): ParsedCommit | null {
  const match = CONVENTIONAL_SUBJECT.exec(commit.subject);
  if (!match) return null;
  const [, type, scoped, breaking, description] = match;
  if (!type || !description) return null;
  return {
    hash: commit.hash,
    type,
    scope: scoped ? scoped.slice(1, -1) : null,
    breaking: Boolean(breaking) || /^BREAKING CHANGE:/m.test(commit.body),
    description: description.trim(),
  };
}

/**
 * Next version from the parsed commits. Pure - the whole derivation is
 * unit-tested without a git checkout.
 */
export function deriveNextVersion(commits: ConventionalCommit[], previous: SemVer | null): SemVer {
  const parsed = commits.map(parseConventionalCommit).filter((c): c is ParsedCommit => c !== null);
  const breaking = parsed.some((c) => c.breaking);
  const feature = parsed.some((c) => c.type === 'feat');
  const zeroX = previous === null || previous.major === 0;

  if (previous === null) return { major: 0, minor: 1, patch: 0, prerelease: null };

  if (breaking) {
    return zeroX
      ? { major: 0, minor: previous.minor + 1, patch: 0, prerelease: null }
      : { major: previous.major + 1, minor: 0, patch: 0, prerelease: null };
  }
  if (feature) {
    return { major: previous.major, minor: previous.minor + 1, patch: 0, prerelease: null };
  }
  return {
    major: previous.major,
    minor: previous.minor,
    patch: previous.patch + 1,
    prerelease: null,
  };
}

/** Markdown release notes grouped by change type (keep-a-changelog style). */
export function renderNotes(
  version: SemVer,
  previousTag: string | null,
  commits: ConventionalCommit[],
): string {
  const parsed = commits.map(parseConventionalCommit).filter((c): c is ParsedCommit => c !== null);
  const compare = previousTag
    ? `Full changelog: [${previousTag}...${formatSemVer(version)}](https://github.com/jdc-projects/xitter/compare/${previousTag}...${formatSemVer(version)})`
    : 'Initial release.';

  const section = (title: string, entries: ParsedCommit[]): string =>
    entries.length === 0
      ? ''
      : `\n\n### ${title}\n\n${entries.map((c) => `- ${c.scope ? `**${c.scope}:** ` : ''}${c.description} (${c.hash})`).join('\n')}`;

  const breaking = parsed.filter((c) => c.breaking);
  const breakingNote =
    breaking.length > 0
      ? `\n\n### Breaking changes\n\n${breaking.map((c) => `- ${c.description} (${c.hash})`).join('\n')}`
      : '';

  return [
    `## ${formatSemVer(version)}`,
    `\n${compare}`,
    breakingNote,
    section(
      'Features',
      parsed.filter((c) => c.type === 'feat' && !c.breaking),
    ),
    section(
      'Fixes',
      parsed.filter((c) => c.type === 'fix' && !c.breaking),
    ),
    section(
      'Internal',
      parsed.filter((c) => c.type !== 'feat' && c.type !== 'fix' && !c.breaking),
    ),
  ].join('');
}

// ---------------------------------------------------------------------------
// git plumbing (thin, not unit-tested - the logic above is)
// ---------------------------------------------------------------------------

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' });
}

/** Highest semver tag reachable from HEAD (`git tag --merged HEAD`). */
export function latestTag(): string | null {
  const tags = git(['tag', '--list', 'v*', '--merged', 'HEAD'])
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean);
  const versions = tags
    .map((tag) => ({ tag, version: parseSemVer(tag) }))
    .filter((t): t is { tag: string; version: SemVer } => t.version !== null)
    .sort((a, b) => {
      const [x, y] = [a.version, b.version];
      if (x.major !== y.major) return x.major - y.major;
      if (x.minor !== y.minor) return x.minor - y.minor;
      if (x.patch !== y.patch) return x.patch - y.patch;
      // SemVer: a prerelease sorts BELOW its own release (null = release).
      if (x.prerelease === y.prerelease) return 0;
      if (x.prerelease === null) return 1;
      if (y.prerelease === null) return -1;
      return x.prerelease.localeCompare(y.prerelease);
    });
  const latest = versions.at(-1);
  return latest === undefined ? null : latest.tag;
}

/** Commit subjects + bodies since `ref` (all of HEAD when ref is null). */
export function commitsSince(ref: string | null): ConventionalCommit[] {
  const range = ref === null ? 'HEAD' : `${ref}..HEAD`;
  const raw = execFileSync('git', ['log', range, '--format=%h%x00%s%x00%B%x00'], {
    encoding: 'utf8',
  });
  // Bodies contain newlines, and git log terminates every record with a
  // newline after the trailing NUL - so the NUL-separated stream chunks into
  // hash/subject/body triplets where every hash after the first carries a
  // leading newline. Strip it; don't split per record.
  const fields = raw.split('\0');
  const commits: ConventionalCommit[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [hash, subject, body] = [fields[i], fields[i + 1], fields[i + 2]];
    if (hash === undefined || subject === undefined || body === undefined) break;
    if (hash !== '')
      commits.push({ hash: hash.replace(/^\n/, ''), subject: subject.replace(/^\n/, ''), body });
  }
  return commits;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function fail(message: string): never {
  console.error(`release-version: ${message}`);
  process.exit(1);
}

interface CliOptions {
  explicit: string | null;
  outDir: string;
}

function parseArgs(args: string[]): CliOptions {
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  return {
    explicit: flag('--explicit') ?? null,
    outDir: flag('--out-dir') ?? '.release',
  };
}

/** The released version: explicit override (validated) or derived from history. */
export function resolveVersion(
  explicit: string | null,
  commits: ConventionalCommit[],
  previousTag: string | null,
): SemVer {
  const previous =
    previousTag === null
      ? null
      : (parseSemVer(previousTag) ?? fail(`existing tag ${previousTag} is not semver`));
  const version =
    explicit === null
      ? deriveNextVersion(commits, previous)
      : (parseSemVer(explicit) ?? fail(`${explicit} is not a valid semver version`));
  if (version.prerelease === null && previous !== null && compareVersions(version, previous) <= 0) {
    fail(`${formatSemVer(version)} is not greater than the latest tag ${previousTag}`);
  }
  return version;
}

function main(): void {
  const { explicit, outDir } = parseArgs(process.argv.slice(2));

  const previousTag = latestTag();
  const commits = commitsSince(previousTag);
  const version = resolveVersion(explicit, commits, previousTag);
  const notes = renderNotes(version, previousTag, commits);

  const result = {
    version: formatSemVer(version),
    previousTag,
    commitCount: commits.length,
    notes,
  };

  const outPath = isAbsolute(outDir) ? outDir : join(findRepoRoot(), outDir);
  mkdirSync(outPath, { recursive: true });
  writeFileSync(
    join(outPath, 'version.json'),
    `${JSON.stringify({ ...result, notes: undefined }, null, 2)}\n`,
  );
  writeFileSync(join(outPath, 'notes.md'), `${notes}\n`);
  console.log(JSON.stringify(result));
}

function compareVersions(a: SemVer, b: SemVer): number {
  return a.major !== b.major
    ? a.major - b.major
    : a.minor !== b.minor
      ? a.minor - b.minor
      : a.patch - b.patch;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
