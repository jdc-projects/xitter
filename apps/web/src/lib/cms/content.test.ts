import { describe, expect, it, vi } from 'vitest';
import { FALLBACK_ABOUT, FALLBACK_FAQ, loadAboutContent, loadFaq, loadPage } from './content';

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

describe('CMS page loading (#215)', () => {
  const pageDoc = {
    id: 4,
    slug: 'changelog',
    title: 'Changelog',
    description: 'What changed',
    sections: [{ heading: 'Pages', body: 'first paragraph' }, { body: 'second paragraph' }],
  };

  it('fetches a published page by slug and maps its sections', async () => {
    const { fetchImpl, requests } = fakeCms([pageDoc]);
    const page = await loadPage('changelog', { fetchImpl });

    expect(page).toMatchObject({
      id: 4,
      slug: 'changelog',
      title: 'Changelog',
      description: 'What changed',
      sections: [
        { heading: 'Pages', body: 'first paragraph' },
        { heading: undefined, body: 'second paragraph' },
      ],
    });
    const call = requests.find((r) => r.url.includes('/cms/api/pages'));
    expect(call!.url).toContain('where%5Bslug%5D%5Bequals%5D=changelog');
    expect(call!.url).toContain('limit=1');
    expect(call!.url).not.toContain('draft=true');
    // Published lookups ride the data cache under the pages tag.
    expect((call!.init as { next?: { tags?: string[] } }).next?.tags).toEqual(['cms-pages']);
  });

  it('reserved slugs never reach the CMS - fixed routes always win', async () => {
    const { fetchImpl, requests } = fakeCms([pageDoc]);
    // about/feed/api/... must resolve to nothing even though the fake CMS
    // would happily return the doc above for any query.
    await expect(loadPage('about', { fetchImpl })).resolves.toBeUndefined();
    await expect(loadPage('feed', { fetchImpl })).resolves.toBeUndefined();
    await expect(loadPage('api', { fetchImpl })).resolves.toBeUndefined();
    expect(requests.filter((r) => r.url.includes('/cms/api/pages'))).toHaveLength(0);
  });

  it('a published doc with a reserved slug is still refused (defence in depth)', async () => {
    const { fetchImpl } = fakeCms([{ ...pageDoc, slug: 'about' }]);
    await expect(loadPage('nomatch', { fetchImpl })).resolves.toBeUndefined();
  });

  it('preview resolves by doc id with a draft, authenticated, uncached fetch', async () => {
    const { fetchImpl, requests } = fakeCms([pageDoc]);
    const page = await loadPage('changelog', { fetchImpl, previewId: '4' });

    expect(page?.slug).toBe('changelog');
    const tokenCall = requests.find((r) => r.url.includes('/protocol/openid-connect/token'));
    const contentCall = requests.find((r) => r.url.includes('/cms/api/pages'));
    expect(tokenCall).toBeDefined();
    expect(contentCall!.url).toContain('where%5Bid%5D%5Bequals%5D=4');
    expect(contentCall!.url).toContain('draft=true');
    expect((contentCall!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect((contentCall!.init as { next?: unknown }).next).toBeUndefined();
  });

  it('unknown slugs and CMS failures resolve to undefined (the route 404s)', async () => {
    const missing = fakeCms([]);
    await expect(loadPage('no-such-page', missing)).resolves.toBeUndefined();

    const erroring = vi.fn(async () => new Response('boom', { status: 503 }));
    await expect(loadPage('changelog', { fetchImpl: erroring })).resolves.toBeUndefined();

    const unreachable = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(loadPage('changelog', { fetchImpl: unreachable })).resolves.toBeUndefined();
  });
});
