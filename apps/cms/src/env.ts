import { localUrl, parseEnv, serviceDbUrl } from '@xitter/config';
import { z } from 'zod';

export const env = parseEnv(
  z.object({
    // Local-only default; a deployed environment must inject a real secret
    // (T1/T9) - a known shared value must never silently guard the admin API.
    PAYLOAD_SECRET: z.string().min(16).default('xitter-local-cms-secret'),
    DATABASE_URL: z.string().min(1).default(serviceDbUrl('cms')),
    WEB_URL: z.string().url().default(localUrl('edge')),
  }),
);

// Local/CI builds may use the default; a deployed environment (envs managed
// by Tofu: dev/prod/anything else) must inject a real secret - a known shared
// value must never silently guard the admin API.
const EPHEMERAL_ENVS = new Set(['local', 'ci']);
if (
  env.PAYLOAD_SECRET === 'xitter-local-cms-secret' &&
  process.env.XITTER_ENV &&
  !EPHEMERAL_ENVS.has(process.env.XITTER_ENV)
) {
  throw new Error('PAYLOAD_SECRET must be set in deployed environments');
}
