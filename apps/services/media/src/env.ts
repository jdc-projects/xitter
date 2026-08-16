import { z } from 'zod';
import {
  kafkaBrokers,
  localPort,
  localUrl,
  parseEnv,
  serviceDbUrl,
  valkeyUrl,
} from '@xitter/config';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(localPort('media')),
  KEYCLOAK_BASE_URL: z.string().url().default(localUrl('keycloak')),
  DEMO_REALM: z.string().min(1).default('xitter-demo'),
  DATABASE_URL: z.string().min(1).default(serviceDbUrl('media')),
  KAFKA_BROKERS: z.string().min(1).default(kafkaBrokers()),
  VALKEY_URL: z.string().url().default(valkeyUrl()),
  // Cluster mode: trust edge-injected identity headers (spec 07).
  AUTH_TRUST_EDGE_HEADERS: z.stringbool().default(false),
});

export const env = parseEnv(envSchema);
