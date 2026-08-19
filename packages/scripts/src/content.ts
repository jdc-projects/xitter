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
  return envString('XITTER_SEED_BASE_URL', localUrl('edge'));
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
  init: RequestInit,
  token: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const res = await fetchImpl(`${cmsBase()}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

async function listExisting(
  collection: 'landing-content' | 'faq',
  token: string,
  fetchImpl: typeof fetch,
): Promise<Array<{ id: number; slug?: string }>> {
  const json = (await api(
    `/cms/api/${collection}?limit=100&depth=0&sort=order`,
    {},
    token,
    fetchImpl,
  )) as { docs?: Array<{ id: number; slug?: string }> };
  return json.docs ?? [];
}

/** Payload's documented way to publish via REST (draft saves go to versions only). */
const PUBLISHED = { _status: 'published' } as const;

async function upsertCollection(
  collection: 'landing-content' | 'faq',
  seeds: Array<Record<string, unknown>>,
  token: string,
  fetchImpl: typeof fetch,
): Promise<ContentApplyResult> {
  const existing = new Map(
    (await listExisting(collection, token, fetchImpl))
      .filter((doc) => doc.slug)
      .map((doc) => [doc.slug as string, doc.id]),
  );

  let created = 0;
  let updated = 0;
  for (const seed of seeds) {
    const id = existing.get(seed.slug as string);
    // _status: published - seed content is live immediately, never a draft.
    const data = JSON.stringify({ ...seed, ...PUBLISHED });
    if (id) {
      await api(
        `/cms/api/${collection}/${id}?draft=false`,
        { method: 'PATCH', body: data },
        token,
        fetchImpl,
      );
      updated += 1;
    } else {
      await api(
        `/cms/api/${collection}?draft=false`,
        { method: 'POST', body: data },
        token,
        fetchImpl,
      );
      created += 1;
    }
  }
  return { created, updated };
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

  const landing = (await listExisting('landing-content', token, doFetch)).slice();
  const faq = (await listExisting('faq', token, doFetch)).slice();

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
    default:
      console.error(`Unknown command: ${command}. Use apply | export.`);
      process.exit(1);
  }
}
