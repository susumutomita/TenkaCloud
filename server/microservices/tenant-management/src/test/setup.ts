import { beforeAll } from 'vitest';

beforeAll(async () => {
  // Set test environment variables
  process.env.NODE_ENV = 'test';
  process.env.DYNAMODB_TABLE_NAME = 'TenkaCloud-test';
});
