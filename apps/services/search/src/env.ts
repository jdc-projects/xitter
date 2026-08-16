import { parseEnv, serviceEnvSchema } from '@xitter/config';

export const env = parseEnv(serviceEnvSchema('search'));
