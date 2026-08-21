import { loadRepoEnv, localUrl } from '@xitter/config';
import KcAdminClient from '@keycloak/keycloak-admin-client';

loadRepoEnv();
console.log('keycloak base:', localUrl('keycloak'));
const kc = new KcAdminClient({ baseUrl: localUrl('keycloak'), realmName: 'master' });
await kc.auth({ grantType: 'password', clientId: 'admin-cli', username: 'admin', password: 'admin' });
for (let i = 0; i < 3; i++) {
  try {
    console.log('realms:', (await kc.realms.find()).map((r) => r.realm));
    break;
  } catch (err) {
    console.log('find attempt', i, 'failed:', err.message);
    await new Promise((r) => setTimeout(r, 500));
  }
}
