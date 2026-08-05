import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@\//,
        replacement: fileURLToPath(new URL('./client/src/', import.meta.url)),
      },
    ],
  },
  test: {
    include: [
      'agent/src/**/__tests__/**/*.test.ts',
      'agent/src/**/*.test.ts',
      'client/src/**/__tests__/**/*.test.ts',
      'client/src/**/*.test.ts',
      'client/src/**/*.test.tsx',
      'scripts/**/*.test.ts',
      'storage/src/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/node_modules'],
    environment: 'node',
    setupFiles: ['./vitest.setup.js'],
    testTimeout: 15_000,
  },
});
