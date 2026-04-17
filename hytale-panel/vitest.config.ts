import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@hytale-panel/shared': path.resolve(__dirname, 'packages/shared/src'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    globals: true,
  },
});