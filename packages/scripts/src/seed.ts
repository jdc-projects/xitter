#!/usr/bin/env tsx
/**
 * Deterministic fake-data seeder: `tsx packages/scripts/src/seed.ts`.
 *
 * Runs against whatever environment its env points at (local via edge proxy, or
 * a deployed environment URL) so local and remote seeding share one code path.
 * Determinism: faker is seeded with a fixed constant; the social graph and post
 * corpus are derived from it, making every environment identical after a reset.
 *
 * Skeleton: seeds demo users + profiles + a follow graph + posts via service
 * APIs. Richer content (images, replies, interactions) lands with the service
 * feature tickets - see docs/specs/data/02-seeding.md.
 */
import { faker } from '@faker-js/faker';
import { envString, loadRepoEnv, localUrl } from '@xitter/config';

const SEED_CONSTANT = 42;
const POSTS_PER_USER = 12;

loadRepoEnv();
faker.seed(SEED_CONSTANT);

interface DemoUser {
  username: string;
}

/** Password grant against the demo realm (allowed for the seeder only). */
/** Password grant against the demo realm (allowed for the seeder only). */
async function loginToken(username: string): Promise<string> {
  const keycloak = envString('XITTER_SEED_KEYCLOAK_URL', localUrl('keycloak'));
  const realm = envString('XITTER_DEMO_REALM', 'xitter-demo');
  const res = await fetch(`${keycloak}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'web',
      username,
      password: envString('XITTER_DEMO_USER_PASSWORD', 'DemoPass123!'),
    }),
  });
  if (!res.ok) throw new Error(`Login failed for ${username}: ${res.status}`);
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

async function authedFetch(path: string, init: RequestInit, token: string): Promise<unknown> {
  const baseUrl = envString('XITTER_SEED_BASE_URL', localUrl('edge'));
  const res = await fetch(`${baseUrl}${path}`, {
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

async function main(): Promise<void> {
  const userCount = Number.parseInt(envString('XITTER_DEMO_USER_COUNT', '10'), 10);
  const users: DemoUser[] = Array.from({ length: userCount }, (_, i) => ({
    username: `demo${i + 1}`,
  }));

  // TODO(feature-social): login per user, ensure profiles, follow graph, posts.
  void loginToken;
  void authedFetch;
  console.log(`seeding ${users.length} profiles, ${POSTS_PER_USER} posts each`);
  console.log('seed skeleton - full implementation lands with the service feature tickets');
}

void main();
