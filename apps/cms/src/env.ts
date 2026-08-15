import { localUrl, parseEnv, serviceDbUrl } from '@xitter/config';
import { z } from 'zod';

export const env = parseEnv(
  z.object({
    PAYLOAD_SECRET: z.string().min(16).default('xitter-local-cms-secret'),
    DATABASE_URL: z.string().min(1).default(serviceDbUrl('cms')),
    WEB_URL: z.string().url().default(localUrl('edge')),
  }),
);
