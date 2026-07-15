import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'agent/src/**/__tests__/**/*.test.ts',
      'agent/src/**/*.test.ts',
      'client/src/**/__tests__/**/*.test.ts',
      'client/src/**/*.test.ts',
      'scripts/**/*.test.ts',
      'storage/src/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/node_modules'],
    environment: 'node',
    setupFiles: ['./vitest.setup.js'],
  },
});
