import { initDynamoDB, BattleRepository } from '@tenkacloud/dynamodb';

// DynamoDB初期化
initDynamoDB({
  // AdminApiStack injects DYNAMODB_TABLE_NAME on Lambda; docker-compose / Makefile set both
  // for back-compat with services that historically read DYNAMODB_TABLE.
  tableName: process.env.DYNAMODB_TABLE_NAME ?? process.env.DYNAMODB_TABLE ?? 'TenkaCloud-dev',
  region: process.env.AWS_REGION ?? 'ap-northeast-1',
  endpoint: process.env.DYNAMODB_ENDPOINT,
});

// リポジトリインスタンス
export const battleRepository = new BattleRepository();
