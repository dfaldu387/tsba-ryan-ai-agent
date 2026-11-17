// ESLint (flat config) for the whole monorepo: backend (Node), frontend (React)
// and the shared package. Type-aware rules are off to keep `npm run lint` fast;
// `npm run typecheck` already covers type errors.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.vite/**', '**/.portal-chrome-profile/**', '**/.portal-sessions/**', '**/*.d.ts', 'frontend/public/**', '_vid/**', 'Question-bank/**', 'scratch-*.mjs', 'docs/**', 'data/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mjs,js}'],
    rules: {
      // Underscore-prefixed names are intentionally unused (placeholders, destructuring).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      // Empty catch blocks are used deliberately for best-effort calls (each has a comment).
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['backend/**/*.{ts,mjs,js}', 'packages/**/*.ts', '*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['frontend/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
