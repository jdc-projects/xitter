import { z } from 'zod';
import { localUrl, type PortName } from './ports.js';

/** Tofu-managed environments (docs/specs/operations/01-environments.md). */
const DEPLOYED_ENVS = new Set(['dev', 'prod']);

/**
 * True in a Tofu-managed environment (dev/prod). Everything else - `local`
 * (the default), `ci`, ephemeral worktree envs - runs against the local
 * docker-compose stack and keeps the localhost defaults.
 */
export function isDeployedEnv(env: string | undefined = process.env.XITTER_ENV): boolean {
  return DEPLOYED_ENVS.has(env ?? 'local');
}

/**
 * Schema for a cross-service URL env var (`XITTER_<SERVICE>_URL`,
 * `*_INTERNAL_URL`). The decision is made at PARSE time, not schema-build
 * time, so one exported schema serves both modes.
 *
 * Locally the localhost fallback is correct - docker forwards the ports -
 * so the default stays. Deployed, an unset URL silently targets the pod
 * itself: every cross-service call ECONNREFUSEDs with no boot signal, which
 * is how posts ran with media attach-validation broken for its entire
 * deployed life (#112, found 2026-08-26). The env schema is the boot
 * boundary, so there the var is REQUIRED and the crash names it (#113).
 *
 * Dependencies (OpenSearch, DB, Kafka, Valkey, Keycloak, RustFS) keep their
 * local defaults in every env - this helper is for service-to-service URLs
 * only.
 */
export function crossServiceUrlSchema(envVar: string, local: PortName) {
  return z.preprocess(
    (value, ctx) => {
      if ((value === undefined || value === '') && isDeployedEnv()) {
        ctx.issues.push({
          code: 'custom',
          input: value,
          message:
            `${envVar} is required in a deployed environment ` +
            `(XITTER_ENV=${process.env.XITTER_ENV ?? 'local'}): unset, this process silently ` +
            `calls localhost and every cross-service request fails with ECONNREFUSED (#113). ` +
            `Set the in-cluster service URL (infra/iac/environments/{dev,prod}/workloads.tf).`,
        });
      }
      return value;
    },
    z.string().url().default(localUrl(local)),
  );
}
