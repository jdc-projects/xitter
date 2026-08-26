import { afterEach, describe, expect, it, vi } from 'vitest';
import type KcAdminClient from '@keycloak/keycloak-admin-client';
import { CLIENT_AUDIENCES } from '@xitter/auth';
import { initDemoRealm } from './keycloak.js';

/**
 * Realm-init behaviour (#80): initDemoRealm must mint EXACTLY the registry's
 * audience map - one mapper per (client, audience), named the way keycloak.tf
 * names them - and delete foreign audience mappers so a pre-fix realm (old
 * script names + Tofu names coexisting) converges instead of duplicating
 * `aud` entries. Client inventory and secret plumbing must stay untouched.
 */

interface MapperPayload {
  name: string;
  protocolMapper: string;
  config: Record<string, string>;
}

interface FakeClient {
  id: string;
  payload: Record<string, unknown>;
  mappers: Map<
    string,
    { id: string; name: string; protocolMapper: string; config: Record<string, string> }
  >;
}

interface FakeState {
  realms: string[];
  clients: Map<string, FakeClient>;
  users: Map<string, { id: string; profile: Record<string, unknown> }>;
  userRoles: Map<string, Set<string>>;
}

/** Minimal in-memory Keycloak covering the surface initDemoRealm touches. */
function fakeKeycloak(seed?: { clientId: string; mappers: MapperPayload[] }): {
  fake: KcAdminClient;
  state: FakeState;
} {
  const state: FakeState = {
    realms: [],
    clients: new Map(),
    users: new Map(),
    userRoles: new Map(),
  };
  const byId = (id: string) => [...state.clients.values()].find((client) => client.id === id);

  const fake = {
    realms: {
      find: async () => state.realms.map((realm) => ({ realm })),
      create: async (payload: { realm: string }) => {
        state.realms.push(payload.realm);
        return {};
      },
      update: async () => ({}),
    },
    roles: {
      create: async () => {},
      findOneByName: async (args: { name: string }) => ({
        id: `role-${args.name}`,
        name: args.name,
      }),
    },
    clients: {
      find: async ({ clientId }: { clientId: string }) =>
        state.clients.has(clientId) ? [{ id: state.clients.get(clientId)!.id }] : [],
      create: async (payload: Record<string, unknown> & { clientId: string }) => {
        state.clients.set(payload.clientId, {
          id: `uuid-${payload.clientId}`,
          payload,
          mappers: new Map(
            seed && seed.clientId === payload.clientId
              ? seed.mappers.map((mapper, index) => [
                  mapper.name,
                  { id: `seed-${index}`, ...mapper },
                ])
              : [],
          ),
        });
        return { id: `uuid-${payload.clientId}` };
      },
      update: async ({ id }: { id: string }, payload: Record<string, unknown>) => {
        Object.assign(byId(id)?.payload ?? {}, payload);
        return {};
      },
      listProtocolMappers: async ({ id }: { id: string }) => [
        ...(byId(id)?.mappers.values() ?? []),
      ],
      addProtocolMapper: async ({ id }: { id: string }, mapper: MapperPayload) => {
        byId(id)?.mappers.set(mapper.name, { id: `mapper-${mapper.name}`, ...mapper });
      },
      delProtocolMapper: async ({ id, mapperId }: { id: string; mapperId: string }) => {
        const client = byId(id);
        const mapper = [...(client?.mappers.values() ?? [])].find((entry) => entry.id === mapperId);
        if (client && mapper) client.mappers.delete(mapper.name);
      },
      getServiceAccountUser: async ({ id }: { id: string }) => ({ id: `sa-${id}` }),
    },
    users: {
      find: async ({ username }: { username: string }) =>
        state.users.has(username)
          ? [{ id: state.users.get(username)!.id, ...state.users.get(username)!.profile }]
          : [],
      create: async (payload: { username: string } & Record<string, unknown>) => {
        state.users.set(payload.username, { id: `user-${payload.username}`, profile: payload });
        return { id: `user-${payload.username}` };
      },
      update: async () => ({}),
      del: async () => ({}),
      listRealmRoleMappings: async ({ id }: { id: string }) =>
        [...(state.userRoles.get(id) ?? [])].map((name) => ({ id: `role-${name}`, name })),
      addRealmRoleMappings: async ({ id, roles }: { id: string; roles: { name: string }[] }) => {
        const set = state.userRoles.get(id) ?? new Set<string>();
        for (const role of roles) set.add(role.name);
        state.userRoles.set(id, set);
      },
    },
  };

  return { fake: fake as unknown as KcAdminClient, state };
}

const mapperNames = (client: FakeClient) => [...client.mappers.keys()].sort();

describe('initDemoRealm audience mappers', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('creates the unchanged client inventory (web + registry machine clients)', async () => {
    vi.stubEnv('XITTER_DEMO_USER_COUNT', '2');
    vi.stubEnv('XITTER_ADMIN_CLIENT_SECRET', 'test-admin-secret');
    const { fake, state } = fakeKeycloak();

    await initDemoRealm({
      adminClient: fake,
      machineSecrets: { 'svc-feed': 'feed-secret-1' },
    });

    expect([...state.clients.keys()].sort()).toEqual(
      ['web', ...Object.keys(CLIENT_AUDIENCES)].sort(),
    );
    expect(state.clients.get('web')?.payload.publicClient).toBe(true);
    // Secret plumbing unchanged (#80 constraint): XITTER_KEYCLOAK_MACHINE_SECRETS
    // entries win, svc-admin keeps its dedicated env var, others fall back.
    expect(state.clients.get('svc-feed')?.payload.secret).toBe('feed-secret-1');
    expect(state.clients.get('svc-admin')?.payload.secret).toBe('test-admin-secret');
    expect(state.clients.get('svc-worker-fanout')?.payload.secret).toBe(
      'svc-worker-fanout-local-secret',
    );
  });

  it('mints exactly one mapper per (client, audience), web stays mapper-free', async () => {
    vi.stubEnv('XITTER_DEMO_USER_COUNT', '2');
    vi.stubEnv('XITTER_ADMIN_CLIENT_SECRET', 'test-admin-secret');
    const { fake, state } = fakeKeycloak();

    await initDemoRealm({ adminClient: fake });

    for (const [clientId, audiences] of Object.entries(CLIENT_AUDIENCES)) {
      const client = state.clients.get(clientId)!;
      expect(mapperNames(client), clientId).toEqual(
        audiences.map((audience) => `audience-${clientId}-to-${audience}`).sort(),
      );
      for (const audience of audiences) {
        const mapper = client.mappers.get(`audience-${clientId}-to-${audience}`)!;
        expect(mapper.protocolMapper).toBe('oidc-audience-mapper');
        expect(mapper.config).toEqual({
          'included.client.audience': audience,
          'access.token.claim': 'true',
          // Matches keycloak.tf's add_to_id_token = false bit-for-bit, or a
          // post-init Tofu plan drifts forever on script-created mappers.
          'id.token.claim': 'false',
        });
      }
    }
    // The browser client mints no service audiences here - the web mappers
    // are a deployed-edge-only concern owned by keycloak.tf.
    expect(state.clients.get('web')!.mappers.size).toBe(0);
  });

  it('deletes foreign audience mappers and never touches other mapper types', async () => {
    vi.stubEnv('XITTER_DEMO_USER_COUNT', '2');
    vi.stubEnv('XITTER_ADMIN_CLIENT_SECRET', 'test-admin-secret');
    const { fake, state } = fakeKeycloak({
      clientId: 'svc-feed',
      mappers: [
        // Old script naming (the #80 duplication): must go.
        {
          name: 'xitter-audience-svc-posts',
          protocolMapper: 'oidc-audience-mapper',
          config: { 'included.client.audience': 'svc-posts' },
        },
        // Legacy comma-joined mapper: must go.
        {
          name: 'xitter-service-audience',
          protocolMapper: 'oidc-audience-mapper',
          config: { 'included.client.audience': 'svc-posts,svc-social' },
        },
        // Already-converged (tofu-named) mapper: kept, NOT re-added.
        {
          name: 'audience-svc-feed-to-svc-feed',
          protocolMapper: 'oidc-audience-mapper',
          config: { 'included.client.audience': 'svc-feed' },
        },
        // Not an audience mapper: never touched.
        {
          name: 'oidc-username-mapper',
          protocolMapper: 'oidc-usermodel-property-mapper',
          config: {},
        },
      ],
    });

    await initDemoRealm({ adminClient: fake });

    expect(mapperNames(state.clients.get('svc-feed')!)).toEqual([
      'audience-svc-feed-to-svc-feed',
      'audience-svc-feed-to-svc-posts',
      'audience-svc-feed-to-svc-social',
      'oidc-username-mapper',
    ]);
  });

  it('converges on re-init (idempotent upsert, nothing duplicated)', async () => {
    vi.stubEnv('XITTER_DEMO_USER_COUNT', '2');
    vi.stubEnv('XITTER_ADMIN_CLIENT_SECRET', 'test-admin-secret');
    const { fake, state } = fakeKeycloak();

    await initDemoRealm({ adminClient: fake });
    await initDemoRealm({ adminClient: fake });

    for (const [clientId, audiences] of Object.entries(CLIENT_AUDIENCES)) {
      expect(mapperNames(state.clients.get(clientId)!), clientId).toEqual(
        audiences.map((audience) => `audience-${clientId}-to-${audience}`).sort(),
      );
    }
  });
});
