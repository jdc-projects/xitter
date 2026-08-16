import tseslint from 'typescript-eslint';

/**
 * Base ESLint config additions for React apps. Compose after the Next/Vite
 * framework config: [...next, ...webConfig(...)]
 */
export const webConfig = tseslint.config(
  {
    ignores: [
      '.next/**',
      'out/**',
      'dist/**',
      'coverage/**',
      'src/generated/**',
      '**/eslint.config.*',
    ],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'eslint.config.mjs',
            'playwright.config.ts',
            '*.config.mjs',
            '*.config.js',
          ],
        },
        tsconfigRootDir: process.cwd(),
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
