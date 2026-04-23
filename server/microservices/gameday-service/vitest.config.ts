import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.d.ts',
        '**/*.test.ts',
        'vitest.config.ts',
        'eslint.config.js',
        'src/lib/logger.ts',
        'src/lib/dynamodb.ts',
        'src/middleware/auth.ts',
        'src/repositories/**',
        'src/data/**',
        'src/types/index.ts',
        'src/index.ts',
      ],
      thresholds: {
        lines: 99,
        functions: 99,
        branches: 99,
        statements: 99,
      },
    },
  },
});
