import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseEnvironment, parseRequest } from '@usebruno/filestore';

/** One .bru file that failed collection-level parsing, with its error. */
export interface BruParseFailure {
  file: string;
  error: string;
}

function walkBruFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkBruFiles(full));
    } else if (entry.endsWith('.bru')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Parse every request and environment .bru file the way the bruno CLI
 * does (same `@usebruno/filestore` parse calls). A request file with a
 * grammar error (e.g. JS `!==` inside an `assert` block) kills the WHOLE
 * `bru run` before any request is sent - the API smoke suite goes dark
 * while every other gate stays green, which is exactly how a broken
 * collection shipped and only the nightly noticed (2026-08-22/23).
 *
 * Returns one failure per unparseable file; empty means the collection is
 * structurally sound (not that its assertions pass - that still needs a
 * live target).
 */
export function parseBrunoCollection(collectionDir: string): BruParseFailure[] {
  const failures: BruParseFailure[] = [];
  for (const file of walkBruFiles(collectionDir)) {
    const content = readFileSync(file, 'utf8');
    const rel = relative(collectionDir, file);
    try {
      if (rel.startsWith('environments')) {
        // The env parser is lenient (swallows malformed vars); this still
        // runs it so a future strict grammar or API change gets caught.
        parseEnvironment(content, { format: 'bru' });
      } else {
        parseRequest(content, { format: 'bru' });
      }
    } catch (err) {
      failures.push({
        file: relative(process.cwd(), file),
        error: String(err).split('\n')[0]?.slice(0, 200) ?? 'parse error',
      });
    }
  }
  return failures;
}
