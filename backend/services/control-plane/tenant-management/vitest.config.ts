import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: {
      NODE_ENV: 'test',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      exclude: [
        'node_modules/**',
        'dist/**',
        'prisma/**',
        '**/*.config.ts',
        '**/*.d.ts',
        '**/test/**',
        '**/*.test.ts',
      ],
      all: true,
      thresholds: {
        lines: 99,
        functions: 99,
        branches: 99,
        statements: 99,
      },
    },
    setupFiles: ['./src/test/setup.ts'],
  },
});
