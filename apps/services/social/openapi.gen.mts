import { buildServiceDocument } from '@xitter/api-contracts';
import { socialApi } from './src/modules/social/social.registry.js';
import { writeFileSync } from 'node:fs';

const document = buildServiceDocument(
  {
    service: 'social',
    title: 'xitter social API',
    description: 'Profiles, follows, and blocks.',
    basePath: '/api/social',
  },
  socialApi,
);

writeFileSync(new URL('./openapi.json', import.meta.url), JSON.stringify(document, null, 2));
console.log('wrote openapi.json');
