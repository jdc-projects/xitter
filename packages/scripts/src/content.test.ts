import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
}

/**
 * Fake Payload + token endpoint. `docs` is returned for collection lists;
 * POST/PATCH are recorded so tests can assert upsert behaviour.
 */
function fakeCms(docs: Record<'landing-content' | 'faq', FakeDoc[]>) {
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
      const list = target.match(/\/cms\/api\/(landing-content|faq)(\?|$)/);
      if (list && list[1]) {
        return new Response(JSON.stringify({ docs: docs[list[1] as 'landing-content'] ?? [] }));
      }
      // POST/PATCH against collection paths: accept.
      if (method === 'POST' || method === 'PATCH') {
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
    expect(files.landingContent.length).toBeGreaterThan(0);
    expect(files.faq.length).toBeGreaterThanOrEqual(7);
    for (const item of [...files.landingContent, ...files.faq]) {
      expect(item.slug).toMatch(/^[a-z0-9-]+$/);
      expect(item.order).toEqual(expect.any(Number));
    }
  });

  it('apply creates missing content as published, authenticated upserts', async () => {
    const { fetchImpl, calls } = fakeCms({ 'landing-content': [], faq: [] });
    const result = await applyCmsContent({ fetchImpl });

    const files = await readContentFiles();
    expect(result.created).toBe(files.landingContent.length + files.faq.length);
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
      'landing-content': files.landingContent.map((entry, i) => ({ id: i + 1, slug: entry.slug })),
      faq: files.faq.map((entry, i) => ({ id: i + 100, slug: entry.slug })),
    };
    const { fetchImpl, calls } = fakeCms(existing);
    const result = await applyCmsContent({ fetchImpl });

    expect(result.created).toBe(0);
    expect(result.updated).toBe(files.landingContent.length + files.faq.length);
    expect(calls.filter((c) => c.method === 'POST' && c.url.includes('/cms/api/'))).toHaveLength(0);
    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(result.updated);
    for (const patch of patches) {
      expect(patch.url).toMatch(/\/cms\/api\/(landing-content|faq)\/\d+\?draft=false/);
    }
  });

  it('export writes deterministic, ordered files (no cluster needed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xitter-content-test-'));
    try {
      const { fetchImpl } = fakeCms({
        'landing-content': [
          { id: 2, slug: 'b', title: 'B', intro: 'i', order: 1 },
          { id: 1, slug: 'a', title: 'A', intro: 'i', order: 0 },
        ],
        faq: [{ id: 9, slug: 'q', question: 'Q?', answer: 'a', order: 0 }],
      });
      await exportCmsContent({ fetchImpl, targetDir: dir });

      const landing = JSON.parse(readFileSync(join(dir, 'landing-content.json'), 'utf8')) as Array<{
        slug: string;
      }>;
      expect(landing.map((e) => e.slug)).toEqual(['a', 'b']);
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

  it('content dir sits under packages/scripts/data/content (runbook 03)', () => {
    expect(CONTENT_DIR).toContain(join('packages', 'scripts', 'data', 'content'));
  });
});
