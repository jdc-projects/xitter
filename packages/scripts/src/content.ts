#!/usr/bin/env tsx
/**
 * CMS site-content promotion (runbook 03 is the human procedure):
 *
 *   apply  - upsert the committed content files into a running Payload
 *            (idempotent, keyed on the unique `slug` field; publishes
 *            immediately). Called by the seeder and safe to re-run.
 *   export - fetch PUBLISHED content from a running Payload with an admin
 *            (client-credentials) token and rewrite the committed files.
 *
 * Both target whatever environment the env points at (XITTER_SEED_BASE_URL
 * defaults to the local edge proxy), so local and deployed share one path.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJwtCache, realmUrls } from '@xitter/auth';
import { envString, loadRepoEnv, localUrl } from '@xitter/config';
import {
  isAmbiguousFailure,
  requestJson,
  SEED_RETRY_CREATE,
  SEED_RETRY_IDEMPOTENT,
  type RetryPolicy,
} from './lib/api.js';
import { serviceBase } from './lib/targets.js';

export interface LandingContentSeed {
  slug: string;
  title: string;
  intro: string;
  order: number;
}

export interface FaqSeed {
  slug: string;
  question: string;
  answer: string;
  order: number;
}

export interface CmsContentFiles {
  landingContent: LandingContentSeed[];
  faq: FaqSeed[];
}

export interface ContentApplyResult {
  created: number;
  updated: number;
}

/** Shape of a doc coming back from a CMS list endpoint during export. */
interface ExportDoc {
  id: number;
  slug: string;
  title?: string;
  intro?: string;
  question?: string;
  answer?: string;
  order?: number;
  _status?: string;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const CONTENT_DIR = resolve(SCRIPT_DIR, '../data/content');

function cmsBase(): string {
  return serviceBase('cms');
}

function cmsToken(fetchImpl?: typeof fetch) {
  const keycloak = envString('XITTER_SEED_KEYCLOAK_URL', localUrl('keycloak'));
  const realm = envString('XITTER_ADMIN_REALM', 'xitter-local-admin');
  return createJwtCache({
    tokenUrl: realmUrls(keycloak, realm).token,
    clientId: envString('XITTER_CMS_CLIENT_ID', 'cms'),
    clientSecret: envString('XITTER_CMS_CLIENT_SECRET', 'cms-local-secret'),
    fetchImpl,
  });
}

async function api(
  path: string,
  init: Parameters<typeof requestJson>[2],
  token: string,
  fetchImpl: typeof fetch,
  retry: RetryPolicy = SEED_RETRY_IDEMPOTENT,
): Promise<unknown> {
  return requestJson(cmsBase(), path, init, token, fetchImpl, retry);
}

async function listExisting(
  collection: 'landing-content' | 'faq',
  token: string,
  fetchImpl: typeof fetch,
  purpose: 'export' | 'apply',
): Promise<Array<{ id: number; slug?: string }>> {
  // Export must ship published copy only: Payload's main table also holds
  // never-published rows, and an admin's draft-only save would otherwise be
  // promoted to every environment (and the nightly reseed) as if published.
  // Apply deliberately lists drafts too - it PATCHes existing docs whatever
  // their state rather than duplicating them.
  const where = purpose === 'export' ? '&where[_status][equals]=published' : '';
  const json = (await api(
    `/cms/api/${collection}?limit=100&depth=0&sort=order${where}`,
    {},
    token,
    fetchImpl,
  )) as { docs?: Array<{ id: number; slug?: string }> };
  return json.docs ?? [];
}

/** Slug -> id for the docs that carry a slug (slug is the promotion key). */
async function existingBySlug(
  collection: 'landing-content' | 'faq',
  token: string,
  fetchImpl: typeof fetch,
  purpose: 'export' | 'apply',
): Promise<Map<string, number>> {
  return new Map(
    (await listExisting(collection, token, fetchImpl, purpose))
      .filter((doc) => doc.slug)
      .map((doc) => [doc.slug as string, doc.id]),
  );
}

/** Payload's documented way to publish via REST (draft saves go to versions only). */
const PUBLISHED = { _status: 'published' } as const;

async function upsertCollection(
  collection: 'landing-content' | 'faq',
  seeds: Array<Record<string, unknown>>,
  token: string,
  fetchImpl: typeof fetch,
): Promise<ContentApplyResult> {
  const existing = await existingBySlug(collection, token, fetchImpl, 'apply');

  let created = 0;
  let updated = 0;
  for (const seed of seeds) {
    const id = existing.get(seed.slug as string);
    // _status: published - seed content is live immediately, never a draft.
    const data = { ...seed, ...PUBLISHED };
    if (id) {
      await api(
        `/cms/api/${collection}/${id}?draft=false`,
        { method: 'PATCH', body: data },
        token,
        fetchImpl,
      );
      updated += 1;
    } else if (await createDoc(collection, data, token, fetchImpl)) {
      created += 1;
    } else {
      // The slug actually existed (reconciled) - the create landed after all.
      updated += 1;
    }
  }
  return { created, updated };
}

/**
 * CMS doc create with ambiguity reconciliation (#85). The list-then-POST
 * is a classic TOCTOU: an in-flight failure (ETIMEDOUT after Payload
 * committed) followed by a blind re-POST would trip the unique `slug`
 * index and fail the run - while the original POST had actually landed.
 * So the create retries only provably-unprocessed causes inside the
 * call; an ambiguous failure re-lists by slug instead. Found = it landed
 * (adopt: the doc already holds exactly this content, nothing to PATCH);
 * absent = it never did, so one deliberate re-create is safe. A second
 * ambiguous failure fails loudly - no loop, exactly like the seed's
 * post-create reconciliation.
 */
async function createDoc(
  collection: 'landing-content' | 'faq',
  data: Record<string, unknown>,
  token: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const create = () =>
    api(
      `/cms/api/${collection}?draft=false`,
      { method: 'POST', body: data },
      token,
      fetchImpl,
      SEED_RETRY_CREATE,
    );
  try {
    await create();
    return true;
  } catch (err) {
    if (!isAmbiguousFailure(err)) throw err;
    // Probe by slug: found = the create landed after all (adopt it - the
    // doc already holds exactly this content, nothing to PATCH); absent =
    // it never did, so one deliberate re-create is safe.
    if ((await existingBySlug(collection, token, fetchImpl, 'apply')).has(data.slug as string)) {
      return false;
    }
    await create();
    return true;
  }
}

/**
 * Apply the committed content files to a running CMS. The seam the nightly
 * reset (and local bootstrap/seed) uses to restore promoted CMS content.
 */
export async function applyCmsContent(
  options: { fetchImpl?: typeof fetch } = {},
): Promise<ContentApplyResult> {
  loadRepoEnv();
  const doFetch = options.fetchImpl ?? fetch;
  const files = await readContentFiles();
  const token = await cmsToken(options.fetchImpl).get();

  const landing = await upsertCollection(
    'landing-content',
    files.landingContent as never,
    token,
    doFetch,
  );
  const faq = await upsertCollection('faq', files.faq as never, token, doFetch);
  return {
    created: landing.created + faq.created,
    updated: landing.updated + faq.updated,
  };
}

/**
 * Reset step for CMS content (spec ops 02): delete every content doc
 * (published or draft - the table truncate equivalent, via Payload's own
 * API so no cross-service DB access), then re-apply the committed files.
 * Admin users/sessions are Payload auth concerns and untouched.
 */
export async function resetCmsContent(
  options: { fetchImpl?: typeof fetch } = {},
): Promise<ContentApplyResult & { deleted: number }> {
  loadRepoEnv();
  const doFetch = options.fetchImpl ?? fetch;
  const token = await cmsToken(doFetch).get();

  let deleted = 0;
  for (const collection of ['landing-content', 'faq'] as const) {
    const docs = await listExisting(collection, token, doFetch, 'apply');
    for (const doc of docs) {
      await api(`/cms/api/${collection}/${doc.id}`, { method: 'DELETE' }, token, doFetch);
      deleted += 1;
    }
  }
  const applied = await applyCmsContent({ fetchImpl: doFetch });
  return { deleted, ...applied };
}

/** Read the committed seed files (also the export target). */
export async function readContentFiles(): Promise<CmsContentFiles> {
  const [landingContent, faq] = await Promise.all([
    readFile(resolve(CONTENT_DIR, 'landing-content.json'), 'utf8'),
    readFile(resolve(CONTENT_DIR, 'faq.json'), 'utf8'),
  ]);
  return {
    landingContent: JSON.parse(landingContent) as LandingContentSeed[],
    faq: JSON.parse(faq) as FaqSeed[],
  };
}

/**
 * Export PUBLISHED content from the CMS as deterministic JSON (sorted by
 * order, fixed key order, trailing newline) so re-running an export over
 * unchanged content produces no diff.
 */
export async function exportCmsContent(
  options: { fetchImpl?: typeof fetch; targetDir?: string } = {},
): Promise<void> {
  loadRepoEnv();
  const doFetch = options.fetchImpl ?? fetch;
  const targetDir = options.targetDir ?? CONTENT_DIR;
  const token = await cmsToken(options.fetchImpl).get();

  const landing = (await listExisting('landing-content', token, doFetch, 'export')).slice();
  const faq = (await listExisting('faq', token, doFetch, 'export')).slice();

  const landingJson = landing.map((doc) => doc as unknown as ExportDoc);
  const faqJson = faq.map((doc) => doc as unknown as ExportDoc);
  const byOrder = (a: ExportDoc, b: ExportDoc): number =>
    (a.order ?? 0) - (b.order ?? 0) || a.slug.localeCompare(b.slug);
  landingJson.sort(byOrder);
  faqJson.sort(byOrder);

  await mkdir(targetDir, { recursive: true });
  await writeFile(
    resolve(targetDir, 'landing-content.json'),
    `${JSON.stringify(
      landingJson.map(({ slug, title, intro, order }) => ({
        slug,
        title,
        intro,
        order: order ?? 0,
      })),
      null,
      2,
    )}\n`,
  );
  await writeFile(
    resolve(targetDir, 'faq.json'),
    `${JSON.stringify(
      faqJson.map(({ slug, question, answer, order }) => ({
        slug,
        question,
        answer,
        order: order ?? 0,
      })),
      null,
      2,
    )}\n`,
  );
  console.log(`exported ${landingJson.length} landing entries, ${faqJson.length} faq entries`);
}

const command = process.argv[2] ?? 'apply';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  switch (command) {
    case 'apply':
      console.log('applying CMS site content...');
      await applyCmsContent().then((r) =>
        console.log(`cms content: ${r.created} created, ${r.updated} updated`),
      );
      break;
    case 'export':
      await exportCmsContent();
      break;
    case 'reset':
      await resetCmsContent().then((r) =>
        console.log(
          `cms content: ${r.deleted} deleted, ${r.created} created, ${r.updated} updated`,
        ),
      );
      break;
    default:
      console.error(`Unknown command: ${command}. Use apply | export | reset.`);
      process.exit(1);
  }
}
