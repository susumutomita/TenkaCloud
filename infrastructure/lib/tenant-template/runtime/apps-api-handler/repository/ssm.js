/**
 * SSM Parameter Store からの broker Entra config / credentials 読み込み。
 *
 * - loadBrokerEntraConfig: per-tenant の broker config を SSM から探す。
 *   無ければ env var (BROKER_ENTRA_GRAPH_PARAMETER_NAME) からの fallback。
 * - loadBrokerEntraCredentials: Microsoft Graph 認証情報 (TENANT_ID/CLIENT_ID/CLIENT_SECRET)
 *   を SSM SecureString から取得する。
 */

const { GetParameterCommand } = require("@aws-sdk/client-ssm");

async function loadBrokerEntraConfig(ssmClient, params) {
  const {
    tenantId,
    tenantConfigPrefix,
    fallbackGraphParameterName,
    fallbackApplicationTemplateId,
  } = params;

  const tenantConfigName = `${tenantConfigPrefix}/${tenantId}/broker-entra/config`;
  try {
    const res = await ssmClient.send(
      new GetParameterCommand({
        Name: tenantConfigName,
        WithDecryption: true,
      }),
    );
    const raw = res.Parameter && res.Parameter.Value;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!parsed.graphParameterName) {
        throw new Error(`broker Entra config must include graphParameterName: ${tenantConfigName}`);
      }
      return {
        profileId: parsed.profileId || "default",
        graphParameterName: parsed.graphParameterName,
        applicationTemplateId: parsed.applicationTemplateId || fallbackApplicationTemplateId,
      };
    }
  } catch (err) {
    if (!err || err.name !== "ParameterNotFound") throw err;
  }

  if (!fallbackGraphParameterName) return null;
  return {
    profileId: "default",
    graphParameterName: fallbackGraphParameterName,
    applicationTemplateId: fallbackApplicationTemplateId,
  };
}

async function loadBrokerEntraCredentials(ssmClient, brokerConfig) {
  if (!brokerConfig || !brokerConfig.graphParameterName) return null;
  if (!brokerConfig.graphParameterName.startsWith("/TenkaCloud/broker-entra/")) {
    throw new Error(
      `broker Entra graphParameterName must be under /TenkaCloud/broker-entra/: ${brokerConfig.graphParameterName}`,
    );
  }
  const res = await ssmClient.send(
    new GetParameterCommand({
      Name: brokerConfig.graphParameterName,
      WithDecryption: true,
    }),
  );
  const raw = res.Parameter && res.Parameter.Value;
  if (!raw)
    throw new Error(
      `empty broker Entra Graph credential parameter: ${brokerConfig.graphParameterName}`,
    );
  const parsed = JSON.parse(raw);
  const tenantId = parsed.TENANT_ID || parsed.tenantId;
  const clientId = parsed.CLIENT_ID || parsed.clientId;
  const clientSecret = parsed.CLIENT_SECRET || parsed.clientSecret;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "broker Entra Graph credentials must include TENANT_ID, CLIENT_ID, and CLIENT_SECRET",
    );
  }
  return { tenantId, clientId, clientSecret };
}

module.exports = {
  loadBrokerEntraConfig,
  loadBrokerEntraCredentials,
};
