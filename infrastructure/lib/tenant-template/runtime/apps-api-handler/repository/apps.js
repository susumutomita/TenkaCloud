/**
 * DynamoDB Apps table I/O. tenantId + appId composite key。
 *
 * 各関数は client / tableName を引数で受けてテスタビリティを確保する
 * (DynamoDBDocumentClient.send() を mock すれば unit test 可能)。
 */

const { PutCommand, QueryCommand, GetCommand, DeleteCommand } = require("@aws-sdk/lib-dynamodb");

async function putApp(ddbClient, tableName, item) {
  await ddbClient.send(new PutCommand({ TableName: tableName, Item: item }));
}

async function getApp(ddbClient, tableName, tenantId, appId) {
  const res = await ddbClient.send(
    new GetCommand({ TableName: tableName, Key: { tenantId, appId } }),
  );
  return res.Item || null;
}

async function listAppsByTenant(ddbClient, tableName, tenantId) {
  const res = await ddbClient.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "tenantId = :t",
      ExpressionAttributeValues: { ":t": tenantId },
    }),
  );
  return res.Items || [];
}

async function deleteApp(ddbClient, tableName, tenantId, appId) {
  await ddbClient.send(new DeleteCommand({ TableName: tableName, Key: { tenantId, appId } }));
}

module.exports = {
  putApp,
  getApp,
  listAppsByTenant,
  deleteApp,
};
