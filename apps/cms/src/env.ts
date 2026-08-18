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

// Local/CI builds may use the default; a deployed environment (envs managed
// by Tofu: dev/prod/anything else) must inject a real secret - a known shared
// value must never silently guard the admin API.
const EPHEMERAL_ENVS = new Set(['local', 'ci']);
export function isEphemeralEnv(): boolean {
  return !process.env.XITTER_ENV || EPHEMERAL_ENVS.has(process.env.XITTER_ENV);
}
if (env.PAYLOAD_SECRET === 'xitter-local-cms-secret' && !isEphemeralEnv()) {
  throw new Error('PAYLOAD_SECRET must be set in deployed environments');
}
