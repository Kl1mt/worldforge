import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const SERVER_URL = process.env.WORLDFORGE_SERVER_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Consume workspace packages (game-core) from TypeScript source.
    conditions: ['source'],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: SERVER_URL, changeOrigin: true },
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
