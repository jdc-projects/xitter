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
import { faker } from "@faker-js/faker";
import { envString, loadRepoEnv } from "@xitter/config";

const SEED_CONSTANT = 42;
const POSTS_PER_USER = 12;
const MAX_FOLLOWS_PER_USER = 4;

loadRepoEnv();

faker.seed(SEED_CONSTANT);

interface DemoUser {
  username: string;
  id: string;
}

async function authedFetch(path: string, init: RequestInit, token: string): Promise<unknown> {
  const baseUrl = envString("XITTER_SEED_BASE_URL", "http://localhost:8080");
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

/** Password grant against the demo realm (allowed for the seeder only). */
async function loginToken(username: string): Promise<string> {
  const keycloak = envString("XITTER_SEED_KEYCLOAK_URL", "http://localhost:8090");
  const realm = envString("XITTER_DEMO_REALM", "xitter-demo");
  const res = await fetch(`${keycloak}/realms/${realm}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "web",
      username,
      password: envString("XITTER_DEMO_USER_PASSWORD", "DemoPass123!"),
    }),
  });
  if (!res.ok) throw new Error(`Login failed for ${username}: ${res.status}`);
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

async function ensureProfile(user: DemoUser, token: string): Promise<void> {
  const displayName = faker.person.firstName() + " " + faker.person.lastName();
  await authedFetch(
    "/api/social/v1/profiles",
    {
      method: "POST",
      body: JSON.stringify({
        id: user.id,
        username: user.username,
        displayName,
        bio: faker.lorem.sentence(),
      }),
    },
    token,
  );
}

async function main(): Promise<void> {
  const userCount = Number.parseInt(envString("XITTER_DEMO_USER_COUNT", "10"), 10);
  const users: DemoUser[] = [];
  for (let i = 1; i <= userCount; i++) {
    users.push({ username: `demo${i}`, id: "" });
  }

  // TODO(feature-social): fetch real keycloak user ids during keycloak:init and pass through.
  console.log(`seeding ${users.length} profiles, ${POSTS_PER_USER} posts each, <= ${MAX_FOLLOWS_PER_USER} follows each`);
  console.log("seed skeleton - full implementation lands with the service feature tickets");
}

void main();
