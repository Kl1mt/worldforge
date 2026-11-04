import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';

export default defineConfig(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', 'art/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['packages/game-core/**/*.ts'],
    languageOptions: { globals: {} },
    rules: {
      // game-core must stay free of DOM and Node APIs.
      'no-restricted-globals': [
        'error',
        'window',
        'document',
        'process',
        'Buffer',
        'localStorage',
        'setTimeout',
        'setInterval',
      ],
      'no-restricted-imports': [
        'error',
        { patterns: ['node:*', 'fs', 'path', 'react', 'react-dom'] },
      ],
    },
  },
  {
    files: ['apps/server/**/*.ts', '*.js', '*.config.ts', 'apps/*/*.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
);
