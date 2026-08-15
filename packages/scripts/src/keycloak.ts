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
import KcAdminClient from "@keycloak/keycloak-admin-client";
import { envInt, envString, loadRepoEnv } from "@xitter/config";
import { keycloakBaseUrl } from "./lib/wait.js";

export interface DemoUser {
  username: string;
  userId: string;
}

export async function createAdminClient(): Promise<KcAdminClient> {
  const kc = new KcAdminClient({ baseUrl: keycloakBaseUrl(), realmName: "master" });
  await kc.auth({
    grantType: "password",
    clientId: "admin-cli",
    username: envString("XITTER_KEYCLOAK_ADMIN_USER", "admin"),
    password: envString("XITTER_KEYCLOAK_ADMIN_PASSWORD", "admin"),
  });
  return kc;
}

export const demoCredentials = () => ({
  realm: envString("XITTER_DEMO_REALM", "xitter-demo"),
  userPrefix: envString("XITTER_DEMO_USER_PREFIX", "demo"),
  userCount: envInt("XITTER_DEMO_USER_COUNT", 10),
  password: envString("XITTER_DEMO_USER_PASSWORD", "DemoPass123!"),
});

/** Service clients issued for machine-to-machine auth; receivers validate audience = own client id. */
export const SERVICE_CLIENTS = ["svc-social", "svc-posts", "svc-media", "svc-feed", "svc-search"] as const;

const edgeUrl = () => `http://localhost:${process.env.XITTER_EDGE_PORT ?? "8080"}`;

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

async function ensureClient(
  kc: KcAdminClient,
  realm: string,
  clientId: string,
  options: { public?: boolean; serviceAccount?: boolean; redirectUris?: string[]; secret?: string },
): Promise<void> {
  const clients = await kc.clients.find({ realm, clientId });
  if (clients.length > 0) {
    console.log(`client ${realm}/${clientId}: exists`);
    return;
  }
  await kc.clients.create({
    realm,
    clientId,
    publicClient: options.public ?? false,
    standardFlowEnabled: (options.redirectUris?.length ?? 0) > 0,
    serviceAccountsEnabled: options.serviceAccount ?? false,
    directAccessGrantsEnabled: false,
    secret: options.secret,
    redirectUris: options.redirectUris ?? [],
    webOrigins: options.redirectUris ? [edgeUrl()] : [],
  });
  console.log(`client ${realm}/${clientId}: created`);
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

async function assignRole(kc: KcAdminClient, realm: string, userId: string, roleName: string): Promise<void> {
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
  roleName: string,
): Promise<DemoUser> {
  const existing = await kc.users.find({ realm, username, exact: true });
  if (existing.length > 0) {
    const userId = existing[0]!.id;
    await assignRole(kc, realm, userId, roleName);
    return { username, userId };
  }
  const created = await kc.users.create({
    realm,
    username,
    enabled: true,
    firstName: username,
    requiredActions: [],
    credentials: [{ type: "password", value: password, temporary: false }],
  });
  await assignRole(kc, realm, created.id, roleName);
  console.log(`user ${realm}/${username}: created`);
  return { username, userId: created.id };
}

export async function initDemoRealm(): Promise<DemoUser[]> {
  loadRepoEnv();
  const kc = await createAdminClient();
  const { realm, userPrefix, userCount, password } = demoCredentials();

  await ensureRealm(kc, realm);
  await ensureRole(kc, realm, "demo-user");

  await ensureClient(kc, realm, "web", {
    public: true,
    redirectUris: [`${edgeUrl()}/*`],
  });
  for (const serviceClient of SERVICE_CLIENTS) {
    await ensureClient(kc, realm, serviceClient, {
      serviceAccount: true,
      secret: `${serviceClient}-local-secret`,
    });
  }

  const users: DemoUser[] = [];
  for (let i = 1; i <= userCount; i++) {
    users.push(await ensureUser(kc, realm, `${userPrefix}${i}`, password, "demo-user"));
  }
  return users;
}

export async function initLocalAdminRealm(): Promise<void> {
  loadRepoEnv();
  const kc = await createAdminClient();
  const realm = envString("XITTER_ADMIN_REALM", "xitter-local-admin");

  await ensureRealm(kc, realm);
  await ensureRole(kc, realm, "app-admin");

  await ensureClient(kc, realm, "admin-panel", { public: true, redirectUris: [`${edgeUrl()}/*`] });
  await ensureClient(kc, realm, "cms", { public: false, secret: "cms-local-secret", redirectUris: [`${edgeUrl()}/*`] });

  await ensureUser(kc, realm, "localadmin", "LocalAdmin123!", "app-admin");
}

export async function resetDemoRealm(): Promise<void> {
  loadRepoEnv();
  const kc = await createAdminClient();
  const realm = demoCredentials().realm;
  try {
    await kc.realms.delete({ realm });
    console.log(`realm ${realm}: deleted`);
  } catch (err) {
    if ((err as { response?: { status?: number } }).response?.status === 404) return;
    throw err;
  }
}
