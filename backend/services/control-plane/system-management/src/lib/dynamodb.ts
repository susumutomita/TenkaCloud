import {
  initDynamoDB,
  AuditLogRepository,
  SystemSettingRepository,
  ServiceHealthRepository,
} from '@tenkacloud/dynamodb';

initDynamoDB({
  tableName: process.env.DYNAMODB_TABLE ?? 'TenkaCloud',
  region: process.env.AWS_REGION ?? 'ap-northeast-1',
  endpoint: process.env.DYNAMODB_ENDPOINT,
});

export const auditLogRepository = new AuditLogRepository();
export const systemSettingRepository = new SystemSettingRepository();
export const serviceHealthRepository = new ServiceHealthRepository();
