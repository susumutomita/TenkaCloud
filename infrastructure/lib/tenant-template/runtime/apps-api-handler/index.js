/**
 * Apps API Lambda handler (#40-c / #63)
 *
 * - POST   /apps            : apps/auth-proxy の Lambda を per-app に動的作成し、
 *                             Function URL を払い出して Cognito UserPoolClient の
 *                             callback URL にも追加。DDB Apps table に状態保存
 * - GET    /apps            : 自テナントの登録アプリ一覧 (DDB Query)
 * - DELETE /apps/{appId}    : per-app Lambda と Function URL を削除、UserPoolClient
 *                             callback URL からも除外、DDB Apps table からも削除
 *
 * tenantId は JWT の custom:tenantId claim から取る (API Gateway Cognito Authorizer
 * が検証済み)。自テナントの item のみ操作する。
 *
 * ファイル責務 (Repository / Service / Controller の 3 層):
 *   - controller (本ファイル): HTTP routing と response 整形のみ
 *   - service/   : workflow (createApp / listApps / deleteApp / configureBrokerEntra)
 *   - repository/: 外部 API I/O (DDB / Lambda / Cognito / SSM / Microsoft Graph)
 *   - shared/    : pure helpers (HTTP utils / naming / Context factory)
 */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
const { LambdaClient } = require("@aws-sdk/client-lambda");
const { CognitoIdentityProviderClient } = require("@aws-sdk/client-cognito-identity-provider");
const { SSMClient } = require("@aws-sdk/client-ssm");

const { createContext } = require("./shared/context");
const { resp, getTenantId, parseBody } = require("./shared/http");
const { createAppsService, CreateAppValidationError } = require("./service/apps");

const ctx = createContext(
  {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    lambda: new LambdaClient({}),
    cognito: new CognitoIdentityProviderClient({}),
    ssm: new SSMClient({}),
  },
  {
    appsTableName: process.env.APPS_TABLE,
    authProxyBucket: process.env.AUTH_PROXY_BUCKET,
    authProxyKey: process.env.AUTH_PROXY_KEY,
    perAppRoleArn: process.env.PER_APP_LAMBDA_ROLE_ARN,
    cognitoDomain: process.env.COGNITO_DOMAIN,
    cognitoClientId: process.env.COGNITO_CLIENT_ID,
    userPoolId: process.env.USER_POOL_ID,
    brokerEntraGraphParameterName: process.env.BROKER_ENTRA_GRAPH_PARAMETER_NAME,
    brokerEntraTenantConfigPrefix:
      process.env.BROKER_ENTRA_TENANT_CONFIG_PREFIX || "/TenkaCloud/tenants",
    brokerEntraApplicationTemplateId: process.env.BROKER_ENTRA_APPLICATION_TEMPLATE_ID,
  },
);

const apps = createAppsService(ctx);

async function handlePost(tenantId, body) {
  try {
    const item = await apps.createApp(tenantId, body);
    return resp(201, item);
  } catch (err) {
    if (err instanceof CreateAppValidationError) return resp(400, { error: err.message });
    throw err;
  }
}

async function handleGet(tenantId) {
  return resp(200, await apps.listApps(tenantId));
}

async function handleDelete(tenantId, appId) {
  const { notFound } = await apps.deleteApp(tenantId, appId);
  if (notFound) return resp(404, { error: "not found" });
  return resp(204, {});
}

exports.handler = async (event) => {
  const tenantId = getTenantId(event);
  if (!tenantId) return resp(401, { error: "missing custom:tenantId claim in JWT" });

  const method = event.httpMethod;
  const appId = event.pathParameters && event.pathParameters.appId;

  try {
    if (method === "POST") return await handlePost(tenantId, parseBody(event));
    if (method === "GET") return await handleGet(tenantId);
    if (method === "DELETE" && appId) return await handleDelete(tenantId, appId);
    return resp(404, { error: "route not found" });
  } catch (err) {
    console.error("handler error:", err);
    return resp(500, { error: (err && err.message) || "internal error" });
  }
};
