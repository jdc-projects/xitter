import tseslint from "typescript-eslint";

/**
 * Base ESLint config additions for React apps. Compose after the Next/Vite
 * framework config: [...next, ...webConfig(...)]
 */
export const webConfig = tseslint.config(
  { ignores: [".next/**", "out/**", "dist/**", "coverage/**", "src/generated/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
