import { createJwtCache, realmUrls } from '@xitter/auth';
import { envString, localUrl } from '@xitter/config';

export interface AboutEntry {
  id?: number;
  slug: string;
  title: string;
  intro: string;
}

export interface FaqEntry {
  id?: number;
  slug: string;
  question: string;
  answer: string;
}

/**
 * Hardcoded fallbacks (spec 04): the About page must never fail because the
 * CMS is unreachable - demo resilience over freshness. Deliberately shorter
 * than the promoted copy so tests can tell seeded CMS content from the
 * fallback. Reset/PII warnings are NOT part of CMS content and always render
 * from code.
 */
export const FALLBACK_ABOUT: AboutEntry[] = [
  {
    slug: 'about-what',
    title: 'What is this?',
    intro: 'A small Twitter/X-style demo - posts, follows, replies, likes and reposts.',
  },
  {
    slug: 'about-why',
    title: 'Why does it exist?',
    intro: 'A playground for building and demonstrating a realistic microservices system.',
  },
  {
    slug: 'about-how',
    title: 'How does it work?',
    intro: 'A web app over small service APIs, with Kafka-driven workers behind them.',
  },
];

export const FALLBACK_FAQ: FaqEntry[] = [
  {
    slug: 'faq-fallback-signup',
    question: 'Can I sign up?',
    answer: 'No. Only the pre-created demo accounts exist.',
  },
  {
    slug: 'faq-fallback-privacy',
    question: 'Is my data private?',
    answer:
      'No. Anyone with a demo account can see everything, and it is all deleted nightly. ' +
      'Never enter personal or sensitive information.',
  },
  {
    slug: 'faq-fallback-broken',
    question: 'Something broke / looks wrong.',
    answer: 'That is part of the fun of a demo - it may also be mid-reset. Check back later.',
  },
];

/** CMS wiring - every URL/credential env-driven (@xitter/config conventions). */
export function cmsEnv() {
  return {
    /** Base the web server fetches Payload REST from (basePath /cms included in paths). */
    baseUrl: envString('XITTER_CMS_URL', localUrl('cms')),
    /** Browser-facing CMS origin (live-preview postMessage + population fetch). */
    publicUrl: envString('XITTER_CMS_PUBLIC_URL', localUrl('edge')),
    keycloakBaseUrl: envString('XITTER_KEYCLOAK_URL', localUrl('keycloak')),
    adminRealm: envString('XITTER_ADMIN_REALM', 'xitter-local-admin'),
    cmsClientId: envString('XITTER_CMS_CLIENT_ID', 'cms'),
    cmsClientSecret: envString('XITTER_CMS_CLIENT_SECRET', 'cms-local-secret'),
  };
}

/** Data-cache tags for published CMS content (see /api/cms/revalidate). */
export const CMS_CACHE_TAGS = ['cms-about-content', 'cms-faq'] as const;

export function adminRealmIssuer(): string {
  return `${cmsEnv().keycloakBaseUrl.replace(/\/$/, '')}/realms/${cmsEnv().adminRealm}`;
}

export interface CmsFetchOptions {
  /** Fetch the latest draft (live preview) instead of published content. */
  draft?: boolean;
  fetchImpl?: typeof fetch;
}

interface PayloadDoc {
  id?: number;
  slug?: string;
  title?: string;
  intro?: string;
  question?: string;
  answer?: string;
  order?: number;
}

let draftTokens: ReturnType<typeof createJwtCache> | undefined;

/**
 * Drafts are auth-gated: fetch a client-credentials token for the cms client.
 * Tests inject their own fetch (no global network access).
 */
function draftToken(fetchImpl?: typeof fetch) {
  const { keycloakBaseUrl, adminRealm, cmsClientId, cmsClientSecret } = cmsEnv();
  if (fetchImpl) {
    return createJwtCache({
      tokenUrl: realmUrls(keycloakBaseUrl, adminRealm).token,
      clientId: cmsClientId,
      clientSecret: cmsClientSecret,
      fetchImpl,
    }).get();
  }
  draftTokens ??= createJwtCache({
    tokenUrl: realmUrls(keycloakBaseUrl, adminRealm).token,
    clientId: cmsClientId,
    clientSecret: cmsClientSecret,
  });
  return draftTokens.get();
}

async function fetchDocs(
  collection: 'about-content' | 'faq',
  options: CmsFetchOptions,
): Promise<PayloadDoc[]> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = new URL(`${cmsEnv().baseUrl}/cms/api/${collection}`);
  url.searchParams.set('limit', '100');
  url.searchParams.set('depth', '0');
  url.searchParams.set('sort', 'order');

  const headers: Record<string, string> = {};
  if (options.draft) {
    url.searchParams.set('draft', 'true');
    headers.authorization = `Bearer ${await draftToken(options.fetchImpl)}`;
  }

  const res = await doFetch(url.toString(), {
    headers,
    // Generous: a booted-but-cold CMS can take seconds on its first query,
    // while an unreachable one fails (ECONNREFUSED) immediately - so the
    // fallback stays fast and slow-cold-starts still render CMS copy.
    signal: AbortSignal.timeout(10_000),
    // Published content rides the Next data cache (ISR-shaped); draft
    // previews are per-request and never cached.
    ...(options.draft ? {} : { next: { revalidate: 60, tags: [`cms-${collection}`] } }),
  });
  if (!res.ok) throw new Error(`CMS ${collection} responded ${res.status}`);
  const json = (await res.json()) as { docs?: PayloadDoc[] };
  const docs = Array.isArray(json.docs) ? json.docs : [];
  if (docs.length > 0 || options.draft) return docs;

  // An EMPTY result means content is not applied yet (suite ordering, or a
  // reset mid-flight). Caching that empty page for 60s would pin the
  // fallback copy even after the content lands - the tag revalidate races
  // whichever parallel render re-caches it. Bypass the data cache for the
  // empty case so the next render sees the applied content immediately.
  const fresh = await doFetch(url.toString(), { headers, cache: 'no-store' });
  if (!fresh.ok) throw new Error(`CMS ${collection} responded ${fresh.status}`);
  const freshJson = (await fresh.json()) as { docs?: PayloadDoc[] };
  return Array.isArray(freshJson.docs) ? freshJson.docs : [];
}

/** Stable CMS-defined ordering: `order` first, slug as tiebreaker. */
function byOrderThenSlug(a: PayloadDoc, b: PayloadDoc): number {
  return (a.order ?? 0) - (b.order ?? 0) || (a.slug ?? '').localeCompare(b.slug ?? '');
}

function mapAbout(docs: PayloadDoc[]): AboutEntry[] {
  return docs
    .slice()
    .sort(byOrderThenSlug)
    .map((doc, i) => ({
      id: doc.id,
      slug: doc.slug ?? `about-${i}`,
      title: doc.title ?? '',
      intro: doc.intro ?? '',
    }));
}

function mapFaq(docs: PayloadDoc[]): FaqEntry[] {
  return docs
    .slice()
    .sort(byOrderThenSlug)
    .map((doc, i) => ({
      id: doc.id,
      slug: doc.slug ?? `faq-${i}`,
      question: doc.question ?? '',
      answer: doc.answer ?? '',
    }));
}

/**
 * About intro sections (About page) from the CMS. Falls back to hardcoded
 * defaults whenever the CMS is unreachable, unhappy, or empty - the About
 * page must never 500.
 */
export async function loadAboutContent(options: CmsFetchOptions = {}): Promise<AboutEntry[]> {
  try {
    const mapped = mapAbout(await fetchDocsWithEmptyRetry('about-content', options));
    return mapped.length > 0 ? mapped : FALLBACK_ABOUT;
  } catch {
    return FALLBACK_ABOUT;
  }
}

/** FAQ entries (About page) from the CMS, with the same fallback contract. */
export async function loadFaq(options: CmsFetchOptions = {}): Promise<FaqEntry[]> {
  try {
    const mapped = mapFaq(await fetchDocsWithEmptyRetry('faq', options));
    return mapped.length > 0 ? mapped : FALLBACK_FAQ;
  } catch {
    return FALLBACK_FAQ;
  }
}

/**
 * An empty CMS result means content is not applied yet (suite ordering,
 * reset mid-flight). A parallel render racing the tag revalidate can re-pin
 * that empty data-cache entry for the full 60s TTL - the fallback copy
 * would then outlive the content - so verify emptiness uncached once. The
 * extra round-trip only happens on the empty path, absent in steady state.
 */
async function fetchDocsWithEmptyRetry(
  collection: 'about-content' | 'faq',
  options: CmsFetchOptions,
): Promise<PayloadDoc[]> {
  const docs = await fetchDocs(collection, options);
  if (docs.length > 0 || options.draft || options.fetchImpl) return docs;
  const res = await fetch(
    `${cmsEnv().baseUrl}/cms/api/${collection}?limit=100&depth=0&sort=order`,
    {
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) return docs;
  const json = (await res.json()) as { docs?: PayloadDoc[] };
  return Array.isArray(json.docs) && json.docs.length > 0 ? json.docs : docs;
}
