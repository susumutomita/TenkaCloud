import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export interface DynamoDBConfig {
  region?: string;
  endpoint?: string;
  tableName: string;
}

let docClient: DynamoDBDocumentClient | null = null;
let tableName: string = '';

export function initDynamoDB(config: DynamoDBConfig): void {
  const client = new DynamoDBClient({
    region: config.region ?? process.env.AWS_REGION ?? 'ap-northeast-1',
    ...(config.endpoint && { endpoint: config.endpoint }),
  });

  docClient = DynamoDBDocumentClient.from(client, {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  });

  tableName = config.tableName;
}

export function getDocClient(): DynamoDBDocumentClient {
  if (!docClient) {
    throw new Error(
      'DynamoDB client not initialized. Call initDynamoDB() first.'
    );
  }
  return docClient;
}

export function getTableName(): string {
  if (!tableName) {
    throw new Error('DynamoDB table name not set. Call initDynamoDB() first.');
  }
  return tableName;
}
