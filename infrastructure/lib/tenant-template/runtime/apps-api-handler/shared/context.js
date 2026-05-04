/**
 * Runtime Context: SDK clients と環境変数を 1 つのオブジェクトに束ねる。
 *
 * これがないと service / repository 関数がひたすら `(deps, env, ...)` を引数で
 * バケツリレーすることになって読みにくいので、Context に集約してから service の
 * factory に渡す設計にしている。
 *
 * @typedef {object} RuntimeEnv
 * @property {string} appsTableName            DDB Apps テーブル名
 * @property {string} authProxyBucket          auth-proxy Lambda zip の S3 bucket
 * @property {string} authProxyKey             auth-proxy Lambda zip の S3 key
 * @property {string} perAppRoleArn            per-app Lambda の IAM Role ARN
 * @property {string} cognitoDomain            Cognito Hosted UI base URL
 * @property {string} cognitoClientId          UserPoolClient ID
 * @property {string} userPoolId               UserPool ID
 * @property {string|undefined} brokerEntraGraphParameterName    SSM 既定 broker creds のパス
 * @property {string} brokerEntraTenantConfigPrefix              SSM tenant config prefix (default `/TenkaCloud/tenants`)
 * @property {string|undefined} brokerEntraApplicationTemplateId Entra applicationTemplate ID
 *
 * @typedef {object} Context
 * @property {object} ddb        DynamoDBDocumentClient
 * @property {object} lambda     LambdaClient
 * @property {object} cognito    CognitoIdentityProviderClient
 * @property {object} ssm        SSMClient
 * @property {RuntimeEnv} env
 */

/**
 * @param {object} clients
 * @param {RuntimeEnv} env
 * @returns {Context}
 */
function createContext(clients, env) {
  return Object.freeze({
    ddb: clients.ddb,
    lambda: clients.lambda,
    cognito: clients.cognito,
    ssm: clients.ssm,
    env: Object.freeze({ ...env }),
  });
}

module.exports = { createContext };
