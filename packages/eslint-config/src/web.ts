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
      // #141 guard: avatars must show the display name's initial, never the
      // username's. Call sites with a profile pass its displayName; call
      // sites without any display name (dormant accounts) omit the prop and
      // take UserAvatar's documented username fallback. Passing a username
      // (directly or off an object) is the bug this rule exists to catch.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "JSXOpeningElement[name.name='UserAvatar'] > JSXAttribute[name.name='displayName'][value.expression.type='Identifier'][value.expression.name='username']",
          message:
            'UserAvatar displayName must be a real display name, never the username itself (#141) - pass the profile displayName or omit the prop (username-initial fallback).',
        },
        {
          selector:
            "JSXOpeningElement[name.name='UserAvatar'] > JSXAttribute[name.name='displayName'][value.expression.property.name='username']",
          message:
            'UserAvatar displayName must be a real display name, never a username property (#141) - pass the profile displayName or omit the prop (username-initial fallback).',
        },
      ],
    },
  },
);
