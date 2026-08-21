/**
 * Target resolution for scripts that run against any environment (local via
 * per-service ports, or a deployed environment via env overrides). Paths are
 * ALWAYS full `/api/{service}/...` routes, so the edge proxy and direct
 * service access share one code path.
 *
 * Resolution per service: `XITTER_<SERVICE>_URL` (the same overrides the
 * api-client uses) → `XITTER_SEED_BASE_URL` (one shared base, e.g. the edge)
 * → the local port for that service.
 */
import { envString, localUrl } from '@xitter/config';

export type ApiTarget = 'social' | 'posts' | 'media' | 'feed' | 'search' | 'cms';

export function serviceBase(target: ApiTarget): string {
  const override = process.env[`XITTER_${target.toUpperCase()}_URL`];
  if (override) return override;
  return envString('XITTER_SEED_BASE_URL', localUrl(target));
}

/** Keycloak base for user/service token grants (defaults to the local port). */
export function keycloakBase(): string {
  return envString('XITTER_SEED_KEYCLOAK_URL', localUrl('keycloak'));
}

export function demoRealm(): string {
  return envString('XITTER_DEMO_REALM', 'xitter-demo');
}

export function tokenEndpoint(): string {
  return `${keycloakBase()}/realms/${demoRealm()}/protocol/openid-connect/token`;
}

/**
 * Password-grant tokens for the demo users (allowed on the `web` client for
 * the seeder only). Cached per user with refresh: seed runs comfortably
 * exceed a token's usefulness window if tokens were minted once.
 */
export class PasswordGrant {
  private readonly tokens = new Map<string, { token: string; obtainedAt: number }>();
  private readonly maxAgeMs = 10 * 60 * 1000; // realm access tokens live 15m

  constructor(
    private readonly options: {
      clientId?: string;
      password?: string;
      fetchImpl?: typeof fetch;
    } = {},
  ) {}

  async token(username: string): Promise<string> {
    const cached = this.tokens.get(username);
    if (cached && Date.now() - cached.obtainedAt < this.maxAgeMs) return cached.token;

    const res = await (this.options.fetchImpl ?? fetch)(tokenEndpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: this.options.clientId ?? 'web',
        username,
        password: this.options.password ?? envString('XITTER_DEMO_USER_PASSWORD', 'DemoPass123!'),
      }),
    });
    if (!res.ok) {
      throw new Error(`login failed for ${username}: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { access_token: string };
    this.tokens.set(username, { token: json.access_token, obtainedAt: Date.now() });
    return json.access_token;
  }
}
