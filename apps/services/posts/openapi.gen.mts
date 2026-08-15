import { buildServiceDocument } from '@xitter/api-contracts';
import { postsApi } from './src/modules/posts.registry.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const document = buildServiceDocument(
  {
    service: 'posts',
    title: 'xitter posts API',
    description: 'Posts, replies, and interactions (likes, bookmarks, reposts).',
    basePath: '/api/posts',
  },
  postsApi,
);

writeFileSync(join(process.cwd(), 'openapi.json'), JSON.stringify(document, null, 2));
console.log('wrote openapi.json');
