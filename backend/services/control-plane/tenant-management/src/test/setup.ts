import { beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma';
import { execSync } from 'child_process';

beforeAll(async () => {
  // Set test database URL
  const testDatabaseUrl =
    process.env.TEST_DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5433/tenkacloud_test?schema=public';

  process.env.DATABASE_URL = testDatabaseUrl;

  // Run migrations on test database
  try {
    execSync('bunx prisma migrate deploy', {
      env: { ...process.env, DATABASE_URL: testDatabaseUrl },
      stdio: 'pipe',
    });
  } catch (error) {
    console.error('Failed to run migrations:', error);
    // Migration might already be applied, continue
  }
});

beforeEach(async () => {
  // Clean up database before each test
  await prisma.tenant.deleteMany();
});

afterAll(async () => {
  // Disconnect from database
  await prisma.$disconnect();
});
