import { localUrl, parseEnv, serviceEnvSchema } from '@xitter/config';
import { z } from 'zod';

export const env = parseEnv(
  serviceEnvSchema('search').extend({
    XITTER_OPENSEARCH_URL: z.string().url().default(localUrl('opensearch')),
  }),
);
