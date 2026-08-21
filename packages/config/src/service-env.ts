import { z } from 'zod';
import { kafkaBrokers, localPort, localUrl, serviceDbUrl, valkeyUrl } from './ports.js';

/**
 * Base env schema every API service shares (PORT, identity, DB, Kafka,
 * Valkey, edge-trust). Services extend with their own vars:
 * `serviceEnvSchema('posts').extend({ ... })`.
 */
export function serviceEnvSchema(service: 'social' | 'posts' | 'media' | 'feed' | 'search') {
  return z.object({
    PORT: z.coerce.number().int().positive().default(localPort(service)),
    KEYCLOAK_BASE_URL: z.string().url().default(localUrl('keycloak')),
    DEMO_REALM: z.string().min(1).default('xitter-demo'),
    // Admin realm (ADR 0006: primary homelab realm, xitter-local-admin
    // locally): issuer for the admin-role-gated internal admin routes.
    ADMIN_REALM: z.string().min(1).default('xitter-local-admin'),
    DATABASE_URL: z.string().min(1).default(serviceDbUrl(service)),
    KAFKA_BROKERS: z.string().min(1).default(kafkaBrokers()),
    VALKEY_URL: z.string().url().default(valkeyUrl()),
    // Cluster mode: trust edge-injected identity headers (spec 07).
    AUTH_TRUST_EDGE_HEADERS: z.stringbool().default(false),
  });
}
