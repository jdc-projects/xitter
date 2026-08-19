import { createJwtCache, realmUrls } from '@xitter/auth';
import { envString, localUrl } from '@xitter/config';

export interface LandingEntry {
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
 * Hardcoded fallbacks (spec 04): landing/About must never fail because the
 * CMS is unreachable - demo resilience over freshness. Reset/PII warnings
 * are NOT part of CMS content and always render from code.
 */
export const FALLBACK_LANDING: LandingEntry[] = [
  {
    slug: 'landing-intro',
    title: '',
    intro:
      'A small Twitter/X-style demo app: posts, follows, replies, likes, bookmarks and reposts - ' +
      'built as a microservices playground for learning and experimentation.',
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
export const CMS_CACHE_TAGS = ['cms-landing-content', 'cms-faq'] as const;

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
  collection: 'landing-content' | 'faq',
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
    ...(options.draft ? {} : { next: { revalidate: 60, tags: [`cms-${collection}`] } }),  });
  if (!res.ok) throw new Error(`CMS ${collection} responded ${res.status}`);
  const json = (await res.json()) as { docs?: PayloadDoc[] };
  return Array.isArray(json.docs) ? json.docs : [];
}

/** Stable CMS-defined ordering: `order` first, slug as tiebreaker. */
function byOrderThenSlug(a: PayloadDoc, b: PayloadDoc): number {
  return (a.order ?? 0) - (b.order ?? 0) || (a.slug ?? '').localeCompare(b.slug ?? '');
}

function mapLanding(docs: PayloadDoc[]): LandingEntry[] {
  return docs
    .slice()
    .sort(byOrderThenSlug)
    .map((doc, i) => ({
      id: doc.id,
      slug: doc.slug ?? `landing-${i}`,
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
 * Landing intro copy from the CMS. Falls back to hardcoded defaults whenever
 * the CMS is unreachable, unhappy, or empty - the landing page must never 500.
 */
export async function loadLandingContent(options: CmsFetchOptions = {}): Promise<LandingEntry[]> {
  try {
    const mapped = mapLanding(await fetchDocs('landing-content', options));
    return mapped.length > 0 ? mapped : FALLBACK_LANDING;
  } catch {
    return FALLBACK_LANDING;
  }
}

/** FAQ entries (About page) from the CMS, with the same fallback contract. */
export async function loadFaq(options: CmsFetchOptions = {}): Promise<FaqEntry[]> {
  try {
    const mapped = mapFaq(await fetchDocs('faq', options));
    return mapped.length > 0 ? mapped : FALLBACK_FAQ;
  } catch {
    return FALLBACK_FAQ;
  }
}
