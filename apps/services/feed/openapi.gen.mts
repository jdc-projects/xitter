import { buildServiceDocument } from '@xitter/api-contracts';
import { feedApi } from './src/modules/feed.registry.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const document = buildServiceDocument(
  {
    service: 'feed',
    title: 'xitter feed API',
    description: 'Materialised home feeds and real-time feed updates.',
    basePath: '/api/feed',
  },
  feedApi,
);

writeFileSync(join(process.cwd(), 'openapi.json'), `${JSON.stringify(document, null, 2)}\n`);
console.log('wrote openapi.json');
