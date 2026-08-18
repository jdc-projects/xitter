import { localUrl, parseEnv, serviceDbUrl } from '@xitter/config';
import { z } from 'zod';

export const env = parseEnv(
  z.object({
    // Local-only default; a deployed environment must inject a real secret
    // (T1/T9) - a known shared value must never silently guard the admin API.
    PAYLOAD_SECRET: z.string().min(16).default('xitter-local-cms-secret'),
    DATABASE_URL: z.string().min(1).default(serviceDbUrl('cms')),
    WEB_URL: z.string().url().default(localUrl('edge')),
    // Admin login (OIDC code flow) + machine draft access (client credentials)
    // both go through the admin realm - see docs/specs/architecture/07-security.md.
    KEYCLOAK_BASE_URL: z.string().url().default(localUrl('keycloak')),
    ADMIN_REALM: z.string().min(1).default('xitter-local-admin'),
    CMS_CLIENT_ID: z.string().min(1).default('cms'),
    CMS_CLIENT_SECRET: z.string().min(1).default('cms-local-secret'),
  }),
);

/**
 * Ephemeral local copies (default, `local`, `ci`, isolated worktree envs like
 * `t9`) auto-push the schema and may use default secrets; deployed
 * environments (envs managed by Tofu: dev, prod) must inject real values.
 */
const DEPLOYED_ENVS = new Set(['dev', 'prod']);
export function isEphemeralEnv(): boolean {
  return !DEPLOYED_ENVS.has(process.env.XITTER_ENV ?? 'local');
}
if (env.PAYLOAD_SECRET === 'xitter-local-cms-secret' && !isEphemeralEnv()) {
  throw new Error('PAYLOAD_SECRET must be set in deployed environments');
}
