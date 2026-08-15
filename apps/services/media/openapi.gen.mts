import { buildServiceDocument } from '@xitter/api-contracts';
import { mediaApi } from './src/modules/media.registry.js';
import { writeFileSync } from 'node:fs';

const document = buildServiceDocument(
  {
    service: 'media',
    title: 'xitter media API',
    description: 'Image uploads: pre-signed URLs, metadata, RustFS-backed storage.',
    basePath: '/api/media',
  },
  mediaApi,
);

writeFileSync(new URL('./openapi.json', import.meta.url), JSON.stringify(document, null, 2));
console.log('wrote openapi.json');
