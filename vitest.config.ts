import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Explicit imports from 'vitest' everywhere; no ambient globals.
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts', 'eval/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'eslint-fixtures/**'],
    // Store adapters (WS1) open real files; keep the default isolated pool.
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
