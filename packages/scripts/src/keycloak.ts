/**
 * Demo Keycloak realm management - the single source of truth for realm setup,
 * used by local bootstrap AND the deployed nightly reset (same idempotent code).
 *
 * Realms:
 *  - XITTER_DEMO_REALM (default "xitter-demo"): demo users + web client + service clients.
 *    Passwords are fixed constants - resetting the realm resets credentials.
 *  - XITTER_ADMIN_REALM (default "xitter-local-admin"): local stand-in for the
 *    homelab "primary" realm, gating admin/CMS login on an app-admin role.
 */
import KcAdminClient from '@keycloak/keycloak-admin-client';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { envInt, envString, loadRepoEnv, localUrl } from '@xitter/config';
import { SERVICE_CLIENTS, WORKER_CLIENTS } from '@xitter/auth';
import { keycloakBaseUrl } from './lib/wait.js';

export interface DemoUser {
  username: string;
  userId: string;
}

export async function createAdminClient(baseUrl?: string): Promise<KcAdminClient> {
  const kc = new KcAdminClient({ baseUrl: baseUrl ?? keycloakBaseUrl(), realmName: 'master' });
  // Keycloak answers /realms/master before its token endpoint reliably
  // accepts connections (transient "other side closed" resets during boot);
  // retry the admin grant until it settles.
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      await kc.auth({
        grantType: 'password',
        clientId: 'admin-cli',
        username: envString('XITTER_KEYCLOAK_ADMIN_USER', 'admin'),
        password: envString('XITTER_KEYCLOAK_ADMIN_PASSWORD', 'admin'),
      });
      return kc;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

export const demoCredentials = () => ({
  realm: envString('XITTER_DEMO_REALM', 'xitter-demo'),
  userPrefix: envString('XITTER_DEMO_USER_PREFIX', 'demo'),
  userCount: envInt('XITTER_DEMO_USER_COUNT', 10),
  password: envString('XITTER_DEMO_USER_PASSWORD', 'DemoPass123!'),
});

/** Retry a transient Keycloak admin call (keep-alive stream races). */
async function withRetry<T>(call: () => Promise<T>, what: string, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (attempt >= attempts) throw err;
      console.log(`keycloak: ${what} attempt ${attempt} failed (${String(err)}) - retrying`);
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
}

// Re-exported for callers of this module; the canonical lists live in
// @xitter/auth so services' guards and the provisioner cannot drift.
export { SERVICE_CLIENTS, WORKER_CLIENTS };

// Deployed runs (nightly reset, ensure-demo-users job) must converge the
// web client on the edge origin tofu manages (keycloak.tf
// valid_redirect_uris) - the local localhost default would clobber it on
// every upsert and break PKCE login until the next apply (observed live).
const edgeUrl = () => envString('XITTER_EDGE_URL', localUrl('edge'));

async function ensureRealm(kc: KcAdminClient, realm: string): Promise<void> {
  // Keycloak 26 keep-alive race: a pooled connection can be closed by the
  // server right after a previous call, killing the next one mid-stream
  // ("unable to read contents from stream"). Timing dependent, heals
  // immediately on the fresh connection - retry both the list and create.
  const realms = await withRetry(() => kc.realms.find(), 'list realms');
  if (realms.some((r) => r.realm === realm)) {
    console.log(`realm ${realm}: exists`);
    await syncBruteForcePosture(kc, realm);
    return;
  }
  await withRetry(
    () =>
      kc.realms.create({
        realm,
        enabled: true,
        // Demo system: users cannot change their own credentials.
        editUsernameAllowed: false,
        resetPasswordAllowed: false,
        registrationAllowed: false,
        loginWithEmailAllowed: false,
        accessTokenLifespan: 900,
        ssoSessionIdleTimeout: 3600,
        ssoSessionMaxLifespan: 43200,
        // T14 login defence: keep brute-force protection on when the reset
        // recreates the realm. The fine-grained fields are rejected by the
        // realm-create endpoint - only the switch is settable here; the
        // tuning is applied right after (and by tofu in-cluster).
        bruteForceProtected: true,
      }),
    `create realm ${realm}`,
  );
  console.log(`realm ${realm}: created`);
  await syncBruteForcePosture(kc, realm);
}

/**
 * Keep the brute-force posture identical to keycloak.tf (the reset-rebuilt
 * realm and the tofu-managed one must not drift). The create endpoint
 * rejects these fields, so they land via an update. quickLoginCheck is
 * disabled: Keycloak 25.0.3+ flags any two logins for the same user inside
 * the window as an attack signal and temporarily disables the account even
 * when both attempts succeed with correct credentials - the e2e suite's
 * parallel demo logins and the seeder's password grants tripped it
 * constantly. Failure-count lockouts (30) stay active.
 */
async function syncBruteForcePosture(kc: KcAdminClient, realm: string): Promise<void> {
  await withRetry(
    () =>
      kc.realms.update(
        { realm },
        {
          bruteForceProtected: true,
          permanentLockout: false,
          // maxLoginFailures (30) and failureResetTimeSeconds (12h) stay at
          // Keycloak's own defaults - the admin-client types lack the fields.
          waitIncrementSeconds: 60,
          minimumQuickLoginWaitSeconds: 60,
          maxFailureWaitSeconds: 900,
          // Also untyped upstream, accepted by the endpoint (verified).
          ...{ quickLoginCheckMilliSeconds: 0 },
        },
      ),
    `sync brute-force posture ${realm}`,
  );
}

interface EnsureClientOptions {
  public?: boolean;
  serviceAccount?: boolean;
  redirectUris?: string[];
  secret?: string;
  directGrants?: boolean;
}

async function ensureClient(
  kc: KcAdminClient,
  realm: string,
  clientId: string,
  options: EnsureClientOptions,
): Promise<string> {
  const clients = await kc.clients.find({ realm, clientId });
  const existing = clients[0]?.id;
  if (existing) {
    // Upsert, not exists: a volume bootstrapped before this config may hold
    // an older shape (e.g. a cms client without a service account) - a
    // plain exists-return would leave bootstrap broken for that stack.
    // Update rejects realm-in-body (create-only field), so strip it.
    const { realm: _realm, ...update } = clientPayload(realm, clientId, options);
    await kc.clients.update({ realm, id: existing }, update);
    console.log(`client ${realm}/${clientId}: exists (synced)`);
    return existing;
  }

  const created = await kc.clients.create(clientPayload(realm, clientId, options));
  console.log(`client ${realm}/${clientId}: created`);
  return created.id;
}

function clientPayload(realm: string, clientId: string, options: EnsureClientOptions) {
  const redirectUris = options.redirectUris ?? [];
  return {
    realm,
    clientId,
    publicClient: options.public === true,
    standardFlowEnabled: redirectUris.length > 0,
    serviceAccountsEnabled: options.serviceAccount === true,
    // Only the seeder uses the password grant (packages/scripts/src/seed.ts).
    directAccessGrantsEnabled: options.directGrants === true,
    secret: options.secret,
    redirectUris,
    webOrigins: redirectUris.length > 0 ? [edgeUrl()] : [],
  };
}

async function ensureRole(kc: KcAdminClient, realm: string, name: string): Promise<void> {
  try {
    await kc.roles.create({ realm, name });
    console.log(`role ${realm}/${name}: created`);
  } catch (err) {
    if ((err as { response?: { status?: number } }).response?.status === 409) return;
    throw err;
  }
}

async function assignRole(
  kc: KcAdminClient,
  realm: string,
  userId: string,
  roleName: string,
): Promise<void> {
  const role = await kc.roles.findOneByName({ realm, name: roleName });
  if (!role) throw new Error(`Role ${roleName} missing in ${realm}`);
  const mappings = await kc.users.listRealmRoleMappings({ realm, id: userId });
  if (mappings.some((m) => m.name === roleName)) return;
  await kc.users.addRealmRoleMappings({
    realm,
    id: userId,
    roles: [{ id: role.id!, name: role.name! }],
  });
}

async function ensureUser(
  kc: KcAdminClient,
  realm: string,
  username: string,
  password: string,
  roleName?: string,
): Promise<DemoUser> {
  const existing = await kc.users.find({ realm, username, exact: true });
  if (existing.length > 0) {
    const userId = existing[0]!.id;
    if (!userId) throw new Error(`User ${username} has no id`);
    if (roleName) await assignRole(kc, realm, userId, roleName);
    await repairDemoUser(kc, realm, userId, username, existing[0]!);
    return { username, userId };
  }
  const created = await kc.users.create({
    realm,
    username,
    enabled: true,
    firstName: username,
    // The default user profile requires all three for role "user"; without
    // them Keycloak answers "Account is not fully set up" at login.
    lastName: 'Demo',
    email: `${username}@demo.xitter.local`,
    emailVerified: true,
    requiredActions: [],
    credentials: [{ type: 'password', value: password, temporary: false }],
  });
  if (roleName) await assignRole(kc, realm, created.id, roleName);
  console.log(`user ${realm}/${username}: created`);
  return { username, userId: created.id };
}

/** Backfill profile completeness on users created before the fix (idempotent). */
async function repairDemoUser(
  kc: KcAdminClient,
  realm: string,
  userId: string,
  username: string,
  user: { email?: string; lastName?: string; emailVerified?: boolean },
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (!user.email) patch.email = `${username}@demo.xitter.local`;
  if (!user.lastName) patch.lastName = 'Demo';
  if (user.emailVerified !== true) patch.emailVerified = true;
  if (Object.keys(patch).length === 0) return;
  await kc.users.update({ realm, id: userId }, patch);
  console.log(`user ${realm}/${username}: profile repaired`);
}

export interface DemoRealmOptions {
  /** Keycloak admin API base (defaults to the local instance). */
  baseUrl?: string;
  /**
   * Secrets for the machine (service-account) clients. Deployed realms use
   * Tofu-managed random secrets; the nightly reset must recreate clients
   * with the SAME secrets or every workload's client-credentials grant
   * breaks. Falls back to the local `${client}-local-secret` convention.
   */
  machineSecrets?: Readonly<Record<string, string>>;
}

export async function initDemoRealm(options: DemoRealmOptions = {}): Promise<DemoUser[]> {
  loadRepoEnv();
  const kc = await createAdminClient(options.baseUrl);
  const { realm, userPrefix, userCount, password } = demoCredentials();

  await ensureRealm(kc, realm);
  await ensureRole(kc, realm, 'demo-user');

  await ensureClient(kc, realm, 'web', {
    public: true,
    redirectUris: [`${edgeUrl()}/*`],
    // Password grant for the deterministic seeder only; user login is OIDC.
    directGrants: true,
  });
  for (const serviceClient of SERVICE_CLIENTS) {
    const uuid = await ensureClient(kc, realm, serviceClient, {
      serviceAccount: true,
      secret: machineSecret(serviceClient, options),
    });
    await ensureAudienceMapper(kc, realm, uuid, SERVICE_CLIENTS);
  }
  for (const worker of WORKER_CLIENTS) {
    const uuid = await ensureClient(kc, realm, worker.clientId, {
      serviceAccount: true,
      secret: machineSecret(worker.clientId, options),
    });
    await ensureAudienceMapper(kc, realm, uuid, worker.audiences);
  }

  // Admin tooling client (T10): a machine principal for bruno/scripts that
  // carries the admin role on its service account - its tokens satisfy the
  // `@Internal({ admin: true })` gate on the services' internal admin
  // endpoints. The panel browser cannot hold a secret, so it uses the
  // admin realm instead; this client is the non-browser path.
  await ensureRole(kc, realm, 'system-admin');
  const adminClientUuid = await ensureClient(kc, realm, 'svc-admin', {
    serviceAccount: true,
    secret: envString('XITTER_ADMIN_CLIENT_SECRET', 'svc-admin-local-secret'),
  });
  await ensureAudienceMapper(kc, realm, adminClientUuid, [...SERVICE_CLIENTS]);
  const adminServiceAccount = await kc.clients.getServiceAccountUser({
    realm,
    id: adminClientUuid,
  });
  if (adminServiceAccount?.id) {
    await assignRole(kc, realm, adminServiceAccount.id, 'system-admin');
  } else {
    throw new Error('svc-admin client service account not found');
  }

  const users: DemoUser[] = [];
  for (let i = 1; i <= userCount; i++) {
    users.push(await ensureUser(kc, realm, `${userPrefix}${i}`, password, 'demo-user'));
  }
  return users;
}

function machineSecret(clientId: string, options: DemoRealmOptions): string {
  return options.machineSecrets?.[clientId] ?? `${clientId}-local-secret`;
}

/**
 * Audience protocol mappers: the client's service-account tokens carry each
 * audience client id as its own `aud` entry, so receivers can validate
 * audience = own client id (the contract @xitter/auth createTokenVerifier
 * enforces). Keycloak's oidc-audience-mapper takes exactly one audience per
 * mapper, so one mapper is created per audience; idempotent by mapper name.
 */
async function ensureAudienceMapper(
  kc: KcAdminClient,
  realm: string,
  clientUuid: string,
  audiences: readonly string[],
): Promise<void> {
  const existing = await kc.clients.listProtocolMappers({ realm, id: clientUuid });
  const existingNames = new Set(existing.map((m) => m.name));

  // Legacy single mapper with a comma-joined audience value - that produced
  // one bogus aud string instead of separate entries; remove when found.
  const legacy = existing.find((m) => m.name === 'xitter-service-audience');
  if (legacy?.id) {
    await kc.clients.delProtocolMapper({
      realm,
      id: clientUuid,
      mapperId: legacy.id,
    });
    existingNames.delete('xitter-service-audience');
    console.log(`client ${realm}: legacy audience mapper removed`);
  }

  for (const audience of audiences) {
    const name = `xitter-audience-${audience}`;
    if (existingNames.has(name)) continue;
    await kc.clients.addProtocolMapper(
      { realm, id: clientUuid },
      {
        protocol: 'openid-connect',
        name,
        protocolMapper: 'oidc-audience-mapper',
        config: {
          'included.client.audience': audience,
          'access.token.claim': 'true',
        },
      },
    );
    console.log(`client ${realm}: audience mapper added (${audience})`);
  }
}

export async function initLocalAdminRealm(): Promise<void> {
  loadRepoEnv();
  const kc = await createAdminClient();
  const realm = envString('XITTER_ADMIN_REALM', 'xitter-local-admin');

  await ensureRealm(kc, realm);
  await ensureRole(kc, realm, 'app-admin');
  // The admin panel's role (spec 07: system-admin gates the admin panel,
  // app-admin the CMS; ADR 0006 lets both log in to admin/CMS).
  await ensureRole(kc, realm, 'system-admin');

  await ensureClient(kc, realm, 'admin-panel', {
    public: true,
    // PKCE code flow from the panel: through the edge (e2e/prod-like) and
    // directly against the vite dev server (local dev parity with the cms
    // client's redirect list).
    redirectUris: [`${edgeUrl()}/*`, `${localUrl('admin')}/*`],
  });
  // Confidential client used twice: the CMS's OIDC browser login (code flow)
  // and machine access to drafts/promotion (client credentials). Direct-port
  // access is allowed too so the CMS works without the edge proxy.
  const cmsClientId = await ensureClient(kc, realm, 'cms', {
    public: false,
    secret: envString('XITTER_CMS_CLIENT_SECRET', 'cms-local-secret'),
    redirectUris: [`${edgeUrl()}/*`, `${localUrl('cms')}/*`],
    serviceAccount: true,
  });
  // The service account carries app-admin so its tokens pass the CMS's
  // role gate (web draft-preview fetch + content export).
  const serviceAccount = await kc.clients.getServiceAccountUser({ realm, id: cmsClientId });
  if (serviceAccount?.id) {
    await assignRole(kc, realm, serviceAccount.id, 'app-admin');
  } else {
    throw new Error('cms client service account not found');
  }

  // localadmin is the local stand-in for the homelab operator: both admin
  // roles, so the CMS (app-admin gate) and the admin panel pass them.
  const localAdmin = await ensureUser(kc, realm, 'localadmin', 'LocalAdmin123!', 'app-admin');
  await assignRole(kc, realm, localAdmin.userId, 'system-admin');
  // Role-less user: the local stand-in for "admin realm user without an
  // admin role" - used to prove the panel rejects them at login.
  await ensureUser(kc, realm, 'localuser', 'LocalUser123!');
}

export async function resetDemoRealm(options: DemoRealmOptions = {}): Promise<void> {
  loadRepoEnv();
  const kc = await createAdminClient(options.baseUrl);
  const realm = demoCredentials().realm;
  // Never delete the realm itself: tofu's keycloak provider owns its
  // config (realm, roles, clients) and its state still references the
  // deleted realm's ids - the next deploy's apply then 409s creating
  // what the reset had re-ensured (observed after manual-reset-6: POST
  // /admin/realms/xitter-demo/roles + /clients -> 409 Conflict). The
  // reset only owns the DATA: users go away, everything else is repaired
  // idempotently by the subsequent init.
  let removed = 0;
  for (const user of await kc.users.find({ realm, max: 1000 })) {
    if (!user.id) continue;
    await kc.users.del({ realm, id: user.id });
    removed++;
  }
  console.log(`realm ${realm}: removed ${removed} user(s) (realm config preserved)`);
}

const command = process.argv[2] ?? 'init';

// Only dispatch when run as the entry file: seed/reset-flow import this
// module and may carry their own argv (e.g. `reset:live -- --seed`), which
// the switch must not try to interpret as a keycloak command.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  switch (command) {
    case 'init':
      await initDemoRealm();
      await initLocalAdminRealm();
      break;
    case 'init-demo':
      await initDemoRealm();
      break;
    case 'init-admin':
      await initLocalAdminRealm();
      break;
    case 'reset-demo':
      await resetDemoRealm();
      break;
    default:
      console.error(`Unknown command: ${command}. Use init | init-demo | init-admin | reset-demo.`);
      process.exit(1);
  }
}
