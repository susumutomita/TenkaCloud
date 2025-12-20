import { initDynamoDB, TenantRepository } from '@tenkacloud/dynamodb';

initDynamoDB({
  tableName: process.env.DYNAMODB_TABLE ?? 'TenkaCloud',
  region: process.env.AWS_REGION ?? 'ap-northeast-1',
  endpoint: process.env.DYNAMODB_ENDPOINT,
});

export const tenantRepository = new TenantRepository();
