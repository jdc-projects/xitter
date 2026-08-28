import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { applyCmsContent, exportCmsContent, readContentFiles, CONTENT_DIR } from './content.js';

interface Call {
  method: string;
  url: string;
  body?: string;
  auth?: string;
}

/** Fake CMS doc shape: list responses only need id + slug for upserts. */
interface FakeDoc {
  id: number;
  slug: string;
  title?: string;
  question?: string;
  answer?: string;
  intro?: string;
  order?: number;
  /** Draft-only docs (never published) - the export filter must drop them. */
  _status?: string;
}

/** Fake Payload + token endpoint. `docs` is returned for collection lists;
 * POST/PATCH are recorded so tests can assert upsert behaviour. `inject`
 * overrides the outcome of matching collection calls (an HTTP status) so
 * the retry contracts (#85) can be pinned against the real apply path.
 */
function fakeCms(
  docs: Record<'about-content' | 'faq', FakeDoc[]>,
  inject: (method: string, url: string) => number | undefined = () => undefined,
) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(
    async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      const target = String(input instanceof Request ? input.url : input);
      const method = (init.method ?? 'GET').toUpperCase();
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({
        method,
        url: target,
        body: typeof init.body === 'string' ? init.body : undefined,
        auth: headers.authorization,
      });

      if (target.includes('/protocol/openid-connect/token')) {
        return new Response(JSON.stringify({ access_token: 'seed-tok', expires_in: 300 }));
      }
      const collection = target.match(/\/cms\/api\/(about-content|faq)(\/\d+)?(\?|$)/);
      if (collection && collection[1]) {
        const injected = inject(method, target);
        if (typeof injected === 'number') {
          return new Response('unavailable', { status: injected });
        }
        if (method === 'GET') {
          const all = docs[collection[1] as 'about-content'] ?? [];
          // Honour the published-only filter the way Payload does, so tests
          // can prove draft rows never ride an export.
          const wantsPublished = decodeURIComponent(target).includes(
            'where[_status][equals]=published',
          );
          const filtered = wantsPublished
            ? all.filter((doc) => (doc as { _status?: string })._status !== 'draft')
            : all;
          return new Response(JSON.stringify({ docs: filtered }));
        }
        // POST/PATCH against collection paths: accept.
        return new Response(JSON.stringify({ doc: {} }), { status: 201 });
      }
      return new Response('not found', { status: 404 });
    },
  );
  return { fetchImpl, calls };
}

describe('content promotion', () => {
  it('reads the committed content files', async () => {
    const files = await readContentFiles();
    expect(files.aboutContent.length).toBeGreaterThan(0);
    expect(files.faq.length).toBeGreaterThanOrEqual(7);
    for (const item of [...files.aboutContent, ...files.faq]) {
      expect(item.slug).toMatch(/^[a-z0-9-]+$/);
      expect(item.order).toEqual(expect.any(Number));
    }
  });

  it('apply creates missing content as published, authenticated upserts', async () => {
    const { fetchImpl, calls } = fakeCms({ 'about-content': [], faq: [] });
    const result = await applyCmsContent({ fetchImpl });

    const files = await readContentFiles();
    expect(result.created).toBe(files.aboutContent.length + files.faq.length);
    expect(result.updated).toBe(0);

    const posts = calls.filter((c) => c.method === 'POST' && c.url.includes('/cms/api/'));
    expect(posts).toHaveLength(result.created);
    for (const post of posts) {
      expect(post.url).toContain('draft=false');
      expect(post.auth).toBe('Bearer seed-tok');
      expect(JSON.parse(post.body!)).toMatchObject({
        slug: expect.any(String),
        _status: 'published',
      });
    }
  });

  it('apply is idempotent: existing slugs are patched, not duplicated', async () => {
    const files = await readContentFiles();
    const existing = {
      'about-content': files.aboutContent.map((entry, i) => ({ id: i + 1, slug: entry.slug })),
      faq: files.faq.map((entry, i) => ({ id: i + 100, slug: entry.slug })),
    };
    const { fetchImpl, calls } = fakeCms(existing);
    const result = await applyCmsContent({ fetchImpl });

    expect(result.created).toBe(0);
    expect(result.updated).toBe(files.aboutContent.length + files.faq.length);
    expect(calls.filter((c) => c.method === 'POST' && c.url.includes('/cms/api/'))).toHaveLength(0);
    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(result.updated);
    for (const patch of patches) {
      expect(patch.url).toMatch(/\/cms\/api\/(about-content|faq)\/\d+\?draft=false/);
    }
  });

  it('export writes deterministic, ordered files (no cluster needed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xitter-content-test-'));
    try {
      const { fetchImpl } = fakeCms({
        'about-content': [
          { id: 2, slug: 'b', title: 'B', intro: 'i', order: 1 },
          { id: 1, slug: 'a', title: 'A', intro: 'i', order: 0 },
        ],
        faq: [{ id: 9, slug: 'q', question: 'Q?', answer: 'a', order: 0 }],
      });
      await exportCmsContent({ fetchImpl, targetDir: dir });

      const about = JSON.parse(readFileSync(join(dir, 'about-content.json'), 'utf8')) as Array<{
        slug: string;
      }>;
      expect(about.map((e) => e.slug)).toEqual(['a', 'b']);
      const faq = JSON.parse(readFileSync(join(dir, 'faq.json'), 'utf8'));
      expect(faq).toEqual([{ slug: 'q', question: 'Q?', answer: 'a', order: 0 }]);

      // Re-running the export over unchanged content is byte-identical.
      const first = readFileSync(join(dir, 'faq.json'), 'utf8');
      await exportCmsContent({ fetchImpl, targetDir: dir });
      expect(readFileSync(join(dir, 'faq.json'), 'utf8')).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('export lists published docs only - a saved draft must not be promoted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xitter-content-test-'));
    try {
      const { fetchImpl, calls } = fakeCms({
        'about-content': [
          { id: 1, slug: 'a', title: 'A', intro: 'i', order: 0 },
          // Saved as draft-only: never published, must not ship.
          { id: 2, slug: 'b', title: 'B draft', intro: 'i', order: 1, _status: 'draft' },
        ],
        faq: [],
      });
      await exportCmsContent({ fetchImpl, targetDir: dir });

      const about = JSON.parse(readFileSync(join(dir, 'about-content.json'), 'utf8')) as Array<{
        slug: string;
      }>;
      expect(about.map((e) => e.slug)).toEqual(['a']);
      const listUrls = calls.filter((c) => c.url.includes('/cms/api/')).map((c) => c.url);
      expect(listUrls.length).toBeGreaterThan(0);
      expect(
        listUrls.every((url) =>
          decodeURIComponent(url).includes('where[_status][equals]=published'),
        ),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('content dir sits under data/content next to src (runbook 03)', () => {
    // Asserted relative to this test file rather than by absolute repo path:
    // the Stryker sandbox relocates the workspace (same relative layout,
    // different root), and the invariant that matters is the derivation -
    // content.ts must resolve its data dir from its own module location,
    // never from cwd or a repo-root assumption.
    const expected = resolve(dirname(fileURLToPath(import.meta.url)), '../data/content');
    expect(CONTENT_DIR).toBe(expected);
    expect(existsSync(CONTENT_DIR)).toBe(true);
  });
});

/**
 * CMS apply retry matrix (#85): the phase rides out deploy churn like the
 * seed's service calls, but keyed by the same idempotency split - slug-
 * keyed reads/patches retry anything transient, while a doc create that
 * fails ambiguously reconciles by re-listing the slug instead of blindly
 * re-POSTing into the unique index.
 */
describe('content apply retries (#85)', () => {
  const postsTo = (calls: Call[], collection: string): number =>
    calls.filter((c) => c.method === 'POST' && c.url.includes(`/cms/api/${collection}`)).length;

  it('retries a 503 on the listing - reads are idempotent', async () => {
    const files = await readContentFiles();
    let lists = 0;
    const { fetchImpl } = fakeCms({ 'about-content': [], faq: [] }, (method, url) => {
      if (method === 'GET' && url.includes('/cms/api/about-content')) {
        lists += 1;
        return lists === 1 ? 503 : undefined;
      }
      return undefined;
    });

    const result = await applyCmsContent({ fetchImpl });

    expect(result.created).toBe(files.aboutContent.length + files.faq.length);
    expect(lists).toBe(2); // one retry, then through
  });

  it('retries a 503 on a PATCH - slug-keyed upserts converge on repeat', async () => {
    const files = await readContentFiles();
    let patches = 0;
    const existing = {
      'about-content': files.aboutContent.map((entry, i) => ({ id: i + 1, slug: entry.slug })),
      faq: files.faq.map((entry, i) => ({ id: i + 100, slug: entry.slug })),
    };
    const { fetchImpl } = fakeCms(existing, (method, _url) => {
      if (method === 'PATCH') {
        patches += 1;
        return patches === 1 ? 503 : undefined;
      }
      return undefined;
    });

    const result = await applyCmsContent({ fetchImpl });

    expect(result.updated).toBe(files.aboutContent.length + files.faq.length);
    expect(result.created).toBe(0);
    expect(patches).toBe(result.updated + 1); // exactly one retried patch
  });

  it('reconciles an ambiguous create failure when the doc landed anyway', async () => {
    const files = await readContentFiles();
    const docs: Record<'about-content' | 'faq', FakeDoc[]> = { 'about-content': [], faq: [] };
    let creates = 0;
    const { fetchImpl, calls } = fakeCms(docs, (method, url) => {
      if (method === 'POST' && url.includes('/cms/api/about-content')) {
        creates += 1;
        if (creates === 1) {
          // Payload committed, then the response was lost (504-class).
          docs['about-content'].push({ id: 900, slug: files.aboutContent[0]!.slug });
          return 504;
        }
      }
      return undefined;
    });

    const result = await applyCmsContent({ fetchImpl });

    // The committed doc was adopted via the slug re-list, never re-POSTed
    // (attempted once, like every other file entry - no extra create).
    expect(postsTo(calls, 'about-content')).toBe(files.aboutContent.length);
    expect(result.created).toBe(files.aboutContent.length + files.faq.length - 1);
    expect(result.updated).toBe(1);
  });

  it('creates once more when an ambiguous create provably never landed', async () => {
    const files = await readContentFiles();
    let creates = 0;
    const { fetchImpl, calls } = fakeCms({ 'about-content': [], faq: [] }, (method, url) => {
      if (method === 'POST' && url.includes('/cms/api/about-content')) {
        creates += 1;
        return creates === 1 ? 504 : undefined; // no commit this time
      }
      return undefined;
    });

    const result = await applyCmsContent({ fetchImpl });

    // One deliberate re-create after the probe found nothing - and no more.
    expect(postsTo(calls, 'about-content')).toBe(files.aboutContent.length + 1);
    expect(result.created).toBe(files.aboutContent.length + files.faq.length);
    expect(result.updated).toBe(0);
  });

  it('never retries a 4xx on the create path - it is a real answer', async () => {
    const { fetchImpl, calls } = fakeCms({ 'about-content': [], faq: [] }, (method, url) => {
      if (method === 'POST' && url.includes('/cms/api/about-content')) return 422;
      return undefined;
    });

    await expect(applyCmsContent({ fetchImpl })).rejects.toThrow(/422/);
    expect(postsTo(calls, 'about-content')).toBe(1);
  });
});
