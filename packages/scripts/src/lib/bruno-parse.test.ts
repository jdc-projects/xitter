import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseBrunoCollection } from './bruno-parse.js';

/**
 * The parser here is the bruno CLI's own (@usebruno/filestore) - these
 * tests pin OUR wiring (file discovery, environment vs request routing,
 * error surfacing), not its grammar.
 */

function collectionWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'bruno-parse-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const VALID_REQUEST = [
  'meta {',
  '  name: Health',
  '  type: http',
  '  seq: 1',
  '}',
  '',
  'get {',
  '  url: {{base}}/healthz',
  '}',
  '',
  'assert {',
  '  res.status: 200',
  '}',
  '',
].join('\n');

// JS in an assert block is the exact regression that took the nightly
// down twice (search-posts.bru, T8-era): the assert DSL only accepts
// `expression: literal`.
const INVALID_REQUEST = VALID_REQUEST.replace(
  'res.status: 200',
  'res.status: 200\n  res.body.items !== undefined',
);

const VALID_ENV = ['vars {', '  token: ""', '  base: http://localhost:8100', '}', ''].join('\n');

describe('parseBrunoCollection', () => {
  it('returns no failures for a well-formed collection', () => {
    const dir = collectionWith({
      'auth/login.bru': VALID_REQUEST,
      'search/search.bru': VALID_REQUEST,
      'environments/local.bru': VALID_ENV,
    });
    try {
      expect(parseBrunoCollection(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the file and error for a request that fails collection parsing', () => {
    const dir = collectionWith({ 'search/search.bru': INVALID_REQUEST });
    try {
      const failures = parseBrunoCollection(dir);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.file).toContain('search.bru');
      expect(failures[0]?.error).toMatch(/Line \d+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
