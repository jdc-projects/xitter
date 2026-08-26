import tseslint from 'typescript-eslint';

/**
 * Base ESLint config for Node workspaces (services, workers, packages).
 * Consumers spread it in their flat config; typed rules use projectService.
 */
export const nodeConfig = tseslint.config(
  { ignores: ['dist/**', 'src/generated/**', 'coverage/**', '**/eslint.config.*'] },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        // vitest.global-setup.ts is config-adjacent glue (outside tsconfig
        // "src" include, like the *.config.ts files) - lint it standalone.
        projectService: {
          allowDefaultProject: ['eslint.config.mjs', '*.config.ts', 'vitest.global-setup.ts'],
        },
        tsconfigRootDir: process.cwd(),
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
    },
  },
);
