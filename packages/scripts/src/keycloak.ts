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
import { envInt, envString, loadRepoEnv, localUrl } from '@xitter/config';
import { SERVICE_CLIENTS, WORKER_CLIENTS } from '@xitter/auth';
import { keycloakBaseUrl } from './lib/wait.js';

export interface DemoUser {
  username: string;
  userId: string;
}

export async function createAdminClient(): Promise<KcAdminClient> {
  const kc = new KcAdminClient({ baseUrl: keycloakBaseUrl(), realmName: 'master' });
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

// Re-exported for callers of this module; the canonical lists live in
// @xitter/auth so services' guards and the provisioner cannot drift.
export { SERVICE_CLIENTS, WORKER_CLIENTS };

const edgeUrl = () => localUrl('edge');

async function ensureRealm(kc: KcAdminClient, realm: string): Promise<void> {
  const realms = await kc.realms.find();
  if (realms.some((r) => r.realm === realm)) {
    console.log(`realm ${realm}: exists`);
    return;
  }
  await kc.realms.create({
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
  });
  console.log(`realm ${realm}: created`);
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
    console.log(`client ${realm}/${clientId}: exists`);
    return existing;
  }

  const payload = clientPayload(realm, clientId, options);
  const created = await kc.clients.create(payload);
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

export async function initDemoRealm(): Promise<DemoUser[]> {
  loadRepoEnv();
  const kc = await createAdminClient();
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
      secret: `${serviceClient}-local-secret`,
    });
    await ensureAudienceMapper(kc, realm, uuid, SERVICE_CLIENTS);
  }
  for (const worker of WORKER_CLIENTS) {
    const uuid = await ensureClient(kc, realm, worker.clientId, {
      serviceAccount: true,
      secret: `${worker.clientId}-local-secret`,
    });
    await ensureAudienceMapper(kc, realm, uuid, worker.audiences);
  }

  const users: DemoUser[] = [];
  for (let i = 1; i <= userCount; i++) {
    users.push(await ensureUser(kc, realm, `${userPrefix}${i}`, password, 'demo-user'));
  }
  return users;
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

  await ensureClient(kc, realm, 'admin-panel', { public: true, redirectUris: [`${edgeUrl()}/*`] });
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

  await ensureUser(kc, realm, 'localadmin', 'LocalAdmin123!', 'app-admin');
  // Role-less user: the local stand-in for "admin realm user without
  // app-admin" - used to prove the CMS rejects them at login.
  await ensureUser(kc, realm, 'localuser', 'LocalUser123!');
}

export async function resetDemoRealm(): Promise<void> {
  loadRepoEnv();
  const kc = await createAdminClient();
  const realm = demoCredentials().realm;
  try {
    await kc.realms.del({ realm });
    console.log(`realm ${realm}: deleted`);
  } catch (err) {
    if ((err as { response?: { status?: number } }).response?.status === 404) return;
    throw err;
  }
}

const command = process.argv[2] ?? 'init';

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
