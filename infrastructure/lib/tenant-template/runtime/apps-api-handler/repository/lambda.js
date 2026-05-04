/**
 * AWS Lambda Service API ラッパー。per-app auth-proxy Lambda の lifecycle を扱う。
 *
 * - createAuthProxyFunction: 新 Lambda 作成 + Active 状態待ち
 * - createPublicFunctionUrl: Function URL (AuthType=NONE) + public invoke 権限
 * - updateAuthProxyEnvironment: Lambda env 更新 + Updated 状態待ち
 * - deleteAuthProxyFunction / deleteAuthProxyFunctionUrl: best-effort 削除
 *
 * waiter の maxWaitTime は API Gateway integration timeout (29s) を意識して
 * 短めに設定 (handler 側で合計時間を予算配分する想定)。
 */

const {
  CreateFunctionCommand,
  DeleteFunctionCommand,
  CreateFunctionUrlConfigCommand,
  DeleteFunctionUrlConfigCommand,
  AddPermissionCommand,
  UpdateFunctionConfigurationCommand,
  waitUntilFunctionActiveV2,
  waitUntilFunctionUpdatedV2,
} = require("@aws-sdk/client-lambda");

async function createAuthProxyFunction(lambdaClient, params) {
  const { functionName, roleArn, sourceBucket, sourceKey, environment, tags } = params;
  const created = await lambdaClient.send(
    new CreateFunctionCommand({
      FunctionName: functionName,
      Runtime: "nodejs20.x",
      Role: roleArn,
      Handler: "lambda.handler",
      Code: { S3Bucket: sourceBucket, S3Key: sourceKey },
      Environment: { Variables: environment },
      Timeout: 30,
      MemorySize: 256,
      Tags: tags,
    }),
  );

  // CreateFunction は async で State="Pending" のまま返る。
  // 後続の CreateFunctionUrlConfig / UpdateFunctionConfiguration は State="Active"
  // を要求するので waiter で遷移を待つ。
  await waitUntilFunctionActiveV2(
    { client: lambdaClient, maxWaitTime: 20 },
    { FunctionName: functionName },
  );

  return created;
}

async function createPublicFunctionUrl(lambdaClient, functionName) {
  // URL を先に作ってから permission を付与するのが canonical パターン
  // (URL 未作成で AddPermission すると Statement が URL に紐づかず Forbidden になる)。
  const urlRes = await lambdaClient.send(
    new CreateFunctionUrlConfigCommand({
      FunctionName: functionName,
      AuthType: "NONE",
    }),
  );

  await lambdaClient.send(
    new AddPermissionCommand({
      FunctionName: functionName,
      StatementId: "FunctionURLAllowPublicAccess",
      Action: "lambda:InvokeFunctionUrl",
      Principal: "*",
      FunctionUrlAuthType: "NONE",
    }),
  );

  return urlRes.FunctionUrl;
}

async function updateAuthProxyEnvironment(lambdaClient, functionName, environment) {
  await lambdaClient.send(
    new UpdateFunctionConfigurationCommand({
      FunctionName: functionName,
      Environment: { Variables: environment },
    }),
  );
  // UpdateFunctionConfiguration も LastUpdateStatus = InProgress の間に
  // 次 API を呼ぶと失敗するので waiter で待つ。
  await waitUntilFunctionUpdatedV2(
    { client: lambdaClient, maxWaitTime: 15 },
    { FunctionName: functionName },
  );
}

async function deleteAuthProxyFunctionUrl(lambdaClient, functionName) {
  await lambdaClient.send(new DeleteFunctionUrlConfigCommand({ FunctionName: functionName }));
}

async function deleteAuthProxyFunction(lambdaClient, functionName) {
  await lambdaClient.send(new DeleteFunctionCommand({ FunctionName: functionName }));
}

module.exports = {
  createAuthProxyFunction,
  createPublicFunctionUrl,
  updateAuthProxyEnvironment,
  deleteAuthProxyFunctionUrl,
  deleteAuthProxyFunction,
};
