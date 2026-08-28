import { describe, expect, it, vi } from 'vitest';
import { FALLBACK_ABOUT, FALLBACK_FAQ, loadAboutContent, loadFaq } from './content';

interface RecordedRequest {
  url: string;
  init: RequestInit;
}

/** Fake fetch: token endpoint + CMS REST, recording every call. */
function fakeCms(docs: unknown[], opts: { status?: number } = {}) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = vi.fn(
    async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      const target = String(input instanceof Request ? input.url : input);
      requests.push({ url: target, init });
      if (target.includes('/protocol/openid-connect/token')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 300 }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ docs }), { status: opts.status ?? 200 });
    },
  );
  return { fetchImpl, requests };
}

const aboutDocs = [
  { id: 2, slug: 'about-second', title: 'Second', intro: 'intro-2', order: 1 },
  { id: 1, slug: 'about-first', title: 'First', intro: 'intro-1', order: 0 },
];

describe('CMS content loading', () => {
  it('maps and orders published About sections', async () => {
    const { fetchImpl } = fakeCms(aboutDocs);
    const entries = await loadAboutContent({ fetchImpl });

    expect(entries.map((e) => e.slug)).toEqual(['about-first', 'about-second']);
    expect(entries[0]).toMatchObject({ id: 1, title: 'First', intro: 'intro-1' });
    const [call] = [fetchImpl.mock.calls[0]!];
    expect(String(call[0])).toContain('/cms/api/about-content');
    expect(String(call[0])).toContain('sort=order');
    expect(String(call[0])).not.toContain('draft=true');
  });

  it('maps and orders FAQ entries', async () => {
    const { fetchImpl } = fakeCms([
      { id: 9, slug: 'faq-b', question: 'B?', answer: 'b', order: 1 },
      { id: 8, slug: 'faq-a', question: 'A?', answer: 'a', order: 0 },
    ]);
    const entries = await loadFaq({ fetchImpl });
    expect(entries.map((e) => e.question)).toEqual(['A?', 'B?']);
  });

  it('falls back to hardcoded copy when the CMS is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED - cms down');
    });
    await expect(loadAboutContent({ fetchImpl })).resolves.toEqual(FALLBACK_ABOUT);
    await expect(loadFaq({ fetchImpl })).resolves.toEqual(FALLBACK_FAQ);
  });

  it('falls back when the CMS errors or returns malformed/empty payloads', async () => {
    const errorStatus = vi.fn(async () => new Response('boom', { status: 503 }));
    await expect(loadAboutContent({ fetchImpl: errorStatus })).resolves.toEqual(FALLBACK_ABOUT);

    const malformed = vi.fn(async () => new Response('<html>not json</html>', { status: 200 }));
    await expect(loadFaq({ fetchImpl: malformed })).resolves.toEqual(FALLBACK_FAQ);

    const empty = vi.fn(async () => new Response(JSON.stringify({ docs: [] }), { status: 200 }));
    await expect(loadAboutContent({ fetchImpl: empty })).resolves.toEqual(FALLBACK_ABOUT);
  });

  it('draft fetches authenticate with a client-credentials token and skip caching', async () => {
    const { fetchImpl, requests } = fakeCms(aboutDocs);
    const entries = await loadAboutContent({ draft: true, fetchImpl });

    expect(entries[0]!.slug).toBe('about-first');
    const tokenCall = requests.find((r) => r.url.includes('/protocol/openid-connect/token'));
    const contentCall = requests.find((r) => r.url.includes('/cms/api/about-content'));
    expect(tokenCall).toBeDefined();
    expect(contentCall!.url).toContain('draft=true');
    expect((contentCall!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect((contentCall!.init as { next?: unknown }).next).toBeUndefined();
  });

  it('draft failures still render (fallback copy, never an error page)', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const target = String(input instanceof Request ? input.url : input);
      if (target.includes('/protocol/openid-connect/token')) {
        return new Response('{"error":"invalid_client"}', { status: 401 });
      }
      throw new Error('unreachable');
    });
    await expect(loadAboutContent({ draft: true, fetchImpl })).resolves.toEqual(FALLBACK_ABOUT);
  });
});
