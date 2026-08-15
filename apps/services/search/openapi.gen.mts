import { buildServiceDocument } from '@xitter/api-contracts';
import { searchApi } from './src/modules/search.registry.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const document = buildServiceDocument(
  {
    service: 'search',
    title: 'xitter search API',
    description: 'Full-text search over posts, backed by OpenSearch.',
    basePath: '/api/search',
  },
  searchApi,
);

writeFileSync(join(process.cwd(), 'openapi.json'), JSON.stringify(document, null, 2));
console.log('wrote openapi.json');
