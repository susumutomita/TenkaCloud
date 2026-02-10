import { initDynamoDB, BattleRepository } from '@tenkacloud/dynamodb';

// DynamoDB初期化
initDynamoDB({
  tableName: process.env.DYNAMODB_TABLE ?? 'TenkaCloud',
  region: process.env.AWS_REGION ?? 'ap-northeast-1',
  endpoint: process.env.DYNAMODB_ENDPOINT,
});

// リポジトリインスタンス
export const battleRepository = new BattleRepository();
