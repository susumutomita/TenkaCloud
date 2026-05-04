/**
 * App lifecycle service: createApp / listApps / deleteApp の orchestration。
 *
 * 関数群は `createAppsService(ctx)` factory が返すクロージャ。Controller (index.js)
 * が 1 度だけ Context を作って factory に渡し、以降は (tenantId, body) だけで呼ぶ。
 * Repository をどう組み合わせるかが Service の責務。
 */

const crypto = require("node:crypto");

const appsRepo = require("../repository/apps");
const lambdaRepo = require("../repository/lambda");
const cognitoRepo = require("../repository/cognito");
const ssmRepo = require("../repository/ssm");
const { createBrokerSamlService } = require("./broker-saml");
const {
  makeFunctionName,
  normalizeGuestEmails,
  assertGuestEmails,
  makeBrokerProviderName,
} = require("../shared/naming");
const {
  DomainAllowlistError,
  normalizeDomainList,
  assertValidDomains,
  assertEmailsInAllowlist,
} = require("../shared/domain-allowlist");

class CreateAppValidationError extends Error {}

function buildAuthProxyEnv(env, options) {
  const {
    upstreamUrl,
    callbackUrl,
    brokerProviderName,
    allowedEmailDomains,
    brokerEntra,
    brokerConfig,
  } = options;
  // JIT invitation (auth-proxy が直接 broker に invite を投げる) に必要な env。
  // brokerEntra が無いケース (broker 未設定 / Cognito 単独 deploy) では undefined
  // のまま注入しないので、auth-proxy 側で `BROKER_ENTRA_GRAPH_PARAMETER_NAME` 等
  // の有無で「JIT 利用可」を判定する。
  const jitEnv =
    brokerEntra && brokerConfig
      ? {
          BROKER_ENTRA_GRAPH_PARAMETER_NAME: brokerConfig.graphParameterName,
          BROKER_SERVICE_PRINCIPAL_ID: brokerEntra.servicePrincipalId,
          BROKER_APP_ROLE_ID: brokerEntra.appRoleId,
          INVITE_REDIRECT_URL: callbackUrl.replace(/\/callback$/, "/"),
        }
      : {};
  return {
    UPSTREAM_URL: upstreamUrl,
    COGNITO_DOMAIN: env.cognitoDomain,
    COGNITO_CLIENT_ID: env.cognitoClientId,
    CALLBACK_URL: callbackUrl,
    ALLOWED_EMAIL_DOMAINS: allowedEmailDomains.join(","),
    ...(brokerProviderName ? { COGNITO_IDENTITY_PROVIDER: brokerProviderName } : {}),
    ...jitEnv,
  };
}

function createAppsService(ctx) {
  const { ddb, lambda, cognito, ssm, env } = ctx;
  const broker = createBrokerSamlService(ctx);

  async function createApp(tenantId, body) {
    if (!body.name || !body.upstreamUrl) {
      throw new CreateAppValidationError("name and upstreamUrl are required");
    }
    const allowedEmailDomains = normalizeDomainList(body.allowedEmailDomains);
    try {
      assertValidDomains(allowedEmailDomains);
    } catch (err) {
      if (err instanceof DomainAllowlistError) throw new CreateAppValidationError(err.message);
      throw err;
    }
    const guestEmails = normalizeGuestEmails(body.guestEmails || body.entraGuestEmails);
    assertGuestEmails(guestEmails);
    // memory: 招待は domain allowlist で必ずフィルタ。guestEmails が allowlist 外
    // のものを含む場合は POST /apps の段階で拒否する (broker-saml にも同 check が
    // 入っているが、こちらが先回りすることで Lambda 作成前に fail-fast できる)。
    try {
      assertEmailsInAllowlist(guestEmails, allowedEmailDomains);
    } catch (err) {
      if (err instanceof DomainAllowlistError) throw new CreateAppValidationError(err.message);
      throw err;
    }

    const brokerConfig = await ssmRepo.loadBrokerEntraConfig(ssm, {
      tenantId,
      tenantConfigPrefix: env.brokerEntraTenantConfigPrefix,
      fallbackGraphParameterName: env.brokerEntraGraphParameterName,
      fallbackApplicationTemplateId: env.brokerEntraApplicationTemplateId,
    });
    if (!brokerConfig && guestEmails.length > 0) {
      throw new Error("broker Entra profile is not configured for this tenant");
    }
    const brokerProviderName = brokerConfig ? makeBrokerProviderName(brokerConfig) : undefined;
    const appId = crypto.randomUUID();
    const functionName = makeFunctionName(tenantId, appId);

    // 順序設計: Lambda 作成 → Function URL → broker.configure → env update。
    // - Lambda を最初に作るのは「broker.configure が Graph API rate-limit / 504 で
    //   flake したとき、Lambda が orphan になるが Function URL が無いので invoke
    //   不可 = コストゼロのゴミ」状態にできるから。retry 安全性が高い。
    // - env update を 1 回に集約しているのは、broker.configure 後にしか分からない
    //   SP id / appRole id を含めて 1 度の UpdateFunctionConfiguration で済ませる
    //   ため (waiter コストを 2 → 1 回に削減)。
    // 既知の制限: broker.configure で失敗すると Lambda が DDB にも記録されず
    //   orphan で残る。`make destroy` の cleanup.sh が prefix 一括削除で sweep する
    //   のでテナント leak はしないが、コストゼロ前提なら気にしなくて良い。
    //
    // 1. Lambda 作成 (env は最終形をまだ知らないので placeholder で先に作る)
    const created = await lambdaRepo.createAuthProxyFunction(lambda, {
      functionName,
      roleArn: env.perAppRoleArn,
      sourceBucket: env.authProxyBucket,
      sourceKey: env.authProxyKey,
      environment: buildAuthProxyEnv(env, {
        upstreamUrl: body.upstreamUrl,
        callbackUrl: "https://placeholder.invalid/callback",
        brokerProviderName,
        allowedEmailDomains,
      }),
      tags: { tenantId, appId, createdBy: "TenkaCloud-apps-api" },
    });

    // 2. Function URL + public invoke 権限
    const functionUrl = await lambdaRepo.createPublicFunctionUrl(lambda, functionName);

    // 3. ブローカー Entra ID + Cognito SAML IdP を構成 (JIT 用に SP id / role id を
    //    取得するためここで実行。Lambda env update より先に走らせる)
    const brokerEntra = await broker.configure({
      tenantId,
      functionUrl,
      guestEmails,
      brokerConfig,
      allowedEmailDomains,
    });

    // 4. Lambda env を 1 度だけ update (CALLBACK_URL + ALLOWED_EMAIL_DOMAINS + JIT)
    await lambdaRepo.updateAuthProxyEnvironment(
      lambda,
      functionName,
      buildAuthProxyEnv(env, {
        upstreamUrl: body.upstreamUrl,
        callbackUrl: `${functionUrl}callback`,
        brokerProviderName,
        allowedEmailDomains,
        brokerEntra,
        brokerConfig,
      }),
    );

    // 5. UserPoolClient に Function URL の callback を追加
    await cognitoRepo.addCallbackUrlToClient(
      cognito,
      env.userPoolId,
      env.cognitoClientId,
      functionUrl,
      brokerEntra && brokerEntra.providerName,
    );

    // 6. DDB Apps row 保存
    const item = {
      tenantId,
      appId,
      name: body.name,
      upstreamUrl: body.upstreamUrl,
      functionName,
      functionUrl,
      functionArn: created.FunctionArn,
      authProvider: brokerEntra ? "CognitoSamlEntraBroker" : "Cognito",
      allowedEmailDomains,
      ...(brokerEntra ? { brokerEntra } : {}),
      status: "active",
      createdAt: new Date().toISOString(),
    };
    await appsRepo.putApp(ddb, env.appsTableName, item);

    return item;
  }

  async function listApps(tenantId) {
    const items = await appsRepo.listAppsByTenant(ddb, env.appsTableName, tenantId);
    return { apps: items };
  }

  async function deleteApp(tenantId, appId) {
    const item = await appsRepo.getApp(ddb, env.appsTableName, tenantId, appId);
    if (!item) return { notFound: true };

    // ベストエフォート: 既に無い resource があっても DDB 削除まで進める。
    // 並行実行で round-trip を節約。表駆動で追加・並べ替えに強くする。
    const cleanups = [
      {
        label: "DeleteFunctionUrlConfig",
        run: () => lambdaRepo.deleteAuthProxyFunctionUrl(lambda, item.functionName),
      },
      {
        label: "DeleteFunction",
        run: () => lambdaRepo.deleteAuthProxyFunction(lambda, item.functionName),
      },
      ...(item.functionUrl
        ? [
            {
              label: "Cognito callback remove",
              run: () =>
                cognitoRepo.removeCallbackUrlFromClient(
                  cognito,
                  env.userPoolId,
                  env.cognitoClientId,
                  item.functionUrl,
                ),
            },
          ]
        : []),
    ];
    const results = await Promise.allSettled(cleanups.map(({ run }) => run()));
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        console.warn(
          `${cleanups[i].label} failed (continuing):`,
          result.reason && result.reason.name,
        );
      }
    });

    await appsRepo.deleteApp(ddb, env.appsTableName, tenantId, appId);
    return { notFound: false };
  }

  return { createApp, listApps, deleteApp };
}

module.exports = { createAppsService, CreateAppValidationError };
