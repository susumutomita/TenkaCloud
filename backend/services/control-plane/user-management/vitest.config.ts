import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.d.ts',
        '**/*.test.ts',
        'vitest.config.ts',
        'src/lib/auth0.ts',
        'src/lib/logger.ts',
        'src/lib/keycloak.ts', // TODO: Delete after migration complete
        'src/lib/prisma.ts', // TODO: Delete after migration complete
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
