import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLIENT_AUDIENCES, SERVICE_CLIENTS } from '@xitter/auth';
import { audienceMapperName } from './keycloak.js';

/**
 * Realm parity (#80, review finding b6): the demo realm's audience map was a
 * contract-by-comment between packages/scripts/src/keycloak.ts (local
 * bootstrap + nightly reset + ensure-demo-users job) and
 * infra/iac/environments/{dev,prod}/keycloak.tf (deploy). These tests promote it to
 * an enforced contract - a change on either side without the other fails
 * here, and the expected map below is pinned to the actual call graph so a
 * consistent-but-wrong edit on both sides fails too.
 */

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '../../..');

/**
 * The call graph, derived from code (NOT to be widened without rewiring the
 * caller): posts validates social relationships + media assets before
 * accepting a post (apps/services/posts/src/modules/{relationship,media}-checker.ts);
 * feed/search hydrate via posts+social bulk lookups
 * (@xitter/service-kit ServiceContentSource); social/media call nothing;
 * workers call only what they feed (apps/workers/<name>/src/main.ts);
 * svc-reset reseeds all five (reset-flow.ts SERVICES); svc-admin is the
 * moderation tooling client (docs/specs/architecture/03-service-interfaces.md).
 */
const EXPECTED_AUDIENCES: Record<string, string[]> = {
  'svc-social': ['svc-social'],
  'svc-posts': ['svc-posts', 'svc-social', 'svc-media'],
  'svc-media': ['svc-media'],
  'svc-feed': ['svc-feed', 'svc-posts', 'svc-social'],
  'svc-search': ['svc-search', 'svc-posts', 'svc-social'],
  'svc-worker-fanout': ['svc-social', 'svc-posts', 'svc-feed'],
  'svc-worker-media-process': ['svc-media'],
  'svc-worker-search-index': ['svc-search', 'svc-social'],
  'svc-reset': [...SERVICE_CLIENTS],
  'svc-admin': [...SERVICE_CLIENTS],
};

/** Tofu manages every machine client except svc-admin (script/tooling-only). */
const TOFU_ONLY_EXCLUSIONS: Record<string, string[]> = {
  dev: ['svc-admin'],
  // Prod additionally has no reset client yet (keycloak.tf: lands with #13).
  prod: ['svc-admin', 'svc-reset'],
};

function readEnvironment(environment: string): string {
  return readFileSync(
    resolve(REPO_ROOT, 'infra/iac/environments', environment, 'keycloak.tf'),
    'utf8',
  );
}

/** Parse `service_clients = ["a", "b"]` from the locals block. */
function parseServiceClients(hcl: string): string[] {
  const list = hcl.match(/service_clients = \[([^\]]*)\]/)?.[1] ?? '';
  return list
    .split(',')
    .map((entry) => entry.trim().replace(/"/g, ''))
    .filter(Boolean);
}

/**
 * Parse the literal `machine_clients = { ... }` map. Entries are either
 * audience lists or a `local.service_clients` reference (svc-reset).
 */
function parseMachineClients(hcl: string): Record<string, string[]> {
  const block = hcl.match(/machine_clients = \{([\s\S]*?)\n  \}/)?.[1];
  expect(block, 'machine_clients locals block not found (literal map required)').toBeDefined();
  const services = parseServiceClients(hcl);
  const clients: Record<string, string[]> = {};
  for (const match of block!.matchAll(
    /"([a-z0-9-]+)"\s*=\s*(\[[^\]]*\]|local\.service_clients)/g,
  )) {
    const clientId = match[1]!;
    const value = match[2]!;
    clients[clientId] = value.startsWith('local.')
      ? [...services]
      : value
          .replace(/[[\]]/g, '')
          .split(',')
          .map((entry) => entry.trim().replace(/"/g, ''))
          .filter(Boolean);
  }
  return clients;
}

function sorted(list: readonly string[]): string[] {
  return [...list].sort();
}

describe('client audience registry', () => {
  it('matches the call graph derived from code', () => {
    expect({ ...CLIENT_AUDIENCES }).toEqual(EXPECTED_AUDIENCES);
  });

  it('only addresses receiver service client ids (guards validate aud = own id)', () => {
    for (const audiences of Object.values(CLIENT_AUDIENCES)) {
      for (const audience of audiences) {
        expect(SERVICE_CLIENTS).toContain(audience);
      }
    }
  });

  it('gives every service client its own audience', () => {
    for (const service of SERVICE_CLIENTS) {
      expect(CLIENT_AUDIENCES[service], service).toContain(service);
    }
  });
});

describe.each(['dev', 'prod'])('keycloak.tf (%s)', (environment) => {
  const hcl = readEnvironment(environment);

  it('machine_clients mirror the registry exactly', () => {
    const tofu = parseMachineClients(hcl);
    const expected = Object.fromEntries(
      Object.entries(CLIENT_AUDIENCES).filter(
        ([clientId]) => !TOFU_ONLY_EXCLUSIONS[environment]!.includes(clientId),
      ),
    );
    expect(Object.keys(tofu).sort()).toEqual(Object.keys(expected).sort());
    for (const [clientId, audiences] of Object.entries(expected)) {
      expect(sorted(tofu[clientId] ?? []), clientId).toEqual(sorted(audiences));
    }
  });

  it('web mappers cover exactly the service clients (deployed edge oidc-api check)', () => {
    // Structural: the web mapper for-expression iterates local.service_clients.
    expect(hcl).toMatch(
      /for aud in local\.service_clients : "web__\$\{aud\}" => \{ client = "web", aud = aud \}/,
    );
    expect(sorted(parseServiceClients(hcl))).toEqual(sorted(SERVICE_CLIENTS));
  });

  it('mints mapper names that match the script-side naming contract', () => {
    // Tofu: name = "audience-${replace(each.key, "__", "-to-")}" over
    // "<client>__<aud>" keys; the script must produce byte-identical names
    // or the two upserts duplicate every mapper (#80).
    expect(hcl).toMatch(/name = "audience-\$\{replace\(each\.key, "__", "-to-"\)\}"/);
    expect(audienceMapperName('svc-feed', 'svc-posts')).toBe('audience-svc-feed-to-svc-posts');
    expect(audienceMapperName('svc-worker-search-index', 'svc-social')).toBe(
      'audience-svc-worker-search-index-to-svc-social',
    );
  });
});
