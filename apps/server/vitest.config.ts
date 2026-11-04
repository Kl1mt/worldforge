import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Each test file creates and migrates its own PGlite database in `beforeAll`. On a cold
    // container (WASM compile + migrations) that exceeded the 10 s default, so CI could flake.
    hookTimeout: 60_000,
  },
});
