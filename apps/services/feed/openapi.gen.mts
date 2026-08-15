import { buildServiceDocument } from '@xitter/api-contracts';
import { feedApi } from './src/modules/feed.registry.js';
import { writeFileSync } from 'node:fs';

const document = buildServiceDocument(
  {
    service: 'feed',
    title: 'xitter feed API',
    description: 'Materialised home feeds and real-time feed updates.',
    basePath: '/api/feed',
  },
  feedApi,
);

writeFileSync(new URL('./openapi.json', import.meta.url), JSON.stringify(document, null, 2));
console.log('wrote openapi.json');
