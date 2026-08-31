import { webConfig } from '@xitter/eslint-config';

export default [
  {
    ignores: [
      // Payload-generated migrations (`payload migrate:create`):
      // generator-owned style, like src/generated - typecheck still covers
      // them via tsconfig.
      'src/migrations/**',
      // Plain-ESM build helper (node-executed from the build script, like
      // next.config.mjs - not part of the tsconfig project service).
      'scripts/bundle-migrations.mjs',
    ],
  },
  ...webConfig,
];
