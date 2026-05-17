import * as path from "node:path";
import { BillingMode } from "aws-cdk-lib/aws-dynamodb";
import { describe, expect, it } from "vitest";
import { resolveApiKeyValue, resolveAppConfig } from "../../lib/app-config/resolve";

const BIN_DIR = path.resolve(__dirname, "..", "..", "bin");

function baseEnv(over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    CDK_PARAM_SYSTEM_ADMIN_EMAIL: "admin@example.com",
    CDK_PARAM_S3_BUCKET_NAME: "test-bucket",
    CDK_SOURCE_NAME: "source.zip",
    CDK_PARAM_COMMIT_ID: "abcdef",
    ...over,
  };
}

function stubProblems() {
  return {
    catalog: [],
    scoring: {},
    endpoints: {},
    phases: {},
    visibility: [],
  };
}

const noopDotenv = () => undefined;
const fsAlwaysMissing = { existsSync: () => false };

describe("resolveAppConfig", () => {
  it("CDK_PARAM_SYSTEM_ADMIN_EMAIL が未設定なら throw すべき", () => {
    expect(() =>
      resolveAppConfig({
        env: baseEnv({ CDK_PARAM_SYSTEM_ADMIN_EMAIL: undefined }),
        binDir: BIN_DIR,
        fs: fsAlwaysMissing,
        dotenvConfig: noopDotenv,
        discoverProblems: stubProblems,
      }),
    ).toThrow(/system admin email/i);
  });

  it("CDK_PARAM_TENANT_ID 未設定なら pooled をデフォルトにし、 isPooledDeploy が true になるべき", () => {
    const cfg = resolveAppConfig({
      env: baseEnv(),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(cfg.tenantId).toBe("pooled");
    expect(cfg.isPooledDeploy).toBe(true);
    expect(cfg.tenantName).toBe("Shared Pooled Tenant");
  });

  it("CDK_PARAM_TENANT_ID が ULID で CDK_PARAM_TENANT_NAME 未設定なら、 tenantName は tenantId にフォールバックすべき", () => {
    const cfg = resolveAppConfig({
      env: baseEnv({ CDK_PARAM_TENANT_ID: "01ABCXYZ" }),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(cfg.tenantId).toBe("01ABCXYZ");
    expect(cfg.tenantName).toBe("01ABCXYZ");
    expect(cfg.isPooledDeploy).toBe(false);
  });

  it("CDK_PARAM_TENANT_NAME が set されていれば優先すべき (#748 fix のもう一段下流)", () => {
    const cfg = resolveAppConfig({
      env: baseEnv({ CDK_PARAM_TENANT_ID: "t-1", CDK_PARAM_TENANT_NAME: "Acme Corp" }),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(cfg.tenantName).toBe("Acme Corp");
  });

  it("DynamoDB billing mode の default は PROVISIONED + 1/1 capacity であるべき (Free Tier 圧迫防止)", () => {
    const cfg = resolveAppConfig({
      env: baseEnv(),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(cfg.dynamoBillingMode).toBe(BillingMode.PROVISIONED);
    expect(cfg.isDynamoProvisioned).toBe(true);
    expect(cfg.dynamoReadCapacity).toBe(1);
    expect(cfg.dynamoWriteCapacity).toBe(1);
  });

  it("CDK_PARAM_DYNAMODB_READ_CAPACITY / WRITE_CAPACITY は env で override 可能", () => {
    const cfg = resolveAppConfig({
      env: baseEnv({
        CDK_PARAM_DYNAMODB_READ_CAPACITY: "5",
        CDK_PARAM_DYNAMODB_WRITE_CAPACITY: "3",
      }),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(cfg.dynamoReadCapacity).toBe(5);
    expect(cfg.dynamoWriteCapacity).toBe(3);
  });

  it("KMS pending window のデフォルトは 7 日 (= dev 環境の destroy コスト最小化)", () => {
    const cfg = resolveAppConfig({
      env: baseEnv(),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(cfg.kmsPendingWindowInDays).toBe(7);
  });

  it("CDK_PARAM_KMS_PENDING_WINDOW_DAYS で 7-30 日を override 可能", () => {
    const cfg = resolveAppConfig({
      env: baseEnv({ CDK_PARAM_KMS_PENDING_WINDOW_DAYS: "21" }),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(cfg.kmsPendingWindowInDays).toBe(21);
  });

  it("namePrefix は `{appNameLower}-{environment}` で組み立てるべき", () => {
    const cfg = resolveAppConfig({
      env: baseEnv(),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(cfg.namePrefix).toBe("tenkacloud-development");
  });

  it("apiKeySSMParameterNames は 4 tier 分の keyId / value 名を namePrefix 込みで返すべき", () => {
    const cfg = resolveAppConfig({
      env: baseEnv(),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(cfg.apiKeySSMParameterNames.basic.keyId).toBe(
      "tenkacloud-development-apiKeyBasicTierKeyId",
    );
    expect(cfg.apiKeySSMParameterNames.platinum.value).toBe(
      "tenkacloud-development-apiKeyPlatinumTierValue",
    );
  });

  it("CDK_PARAM_DEPLOY_CONCURRENT_BUILD_LIMIT が整数でなければ throw すべき", () => {
    expect(() =>
      resolveAppConfig({
        env: baseEnv({ CDK_PARAM_DEPLOY_CONCURRENT_BUILD_LIMIT: "abc" }),
        binDir: BIN_DIR,
        fs: fsAlwaysMissing,
        dotenvConfig: noopDotenv,
        discoverProblems: stubProblems,
      }),
    ).toThrow(/整数で指定/);
  });

  it("CDK_PARAM_DEPLOY_CONCURRENT_BUILD_LIMIT が未設定なら undefined を返すべき (= account-level quota 任せ)", () => {
    const cfg = resolveAppConfig({
      env: baseEnv(),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(cfg.deployConcurrentBuildLimit).toBeUndefined();
  });

  it("CDK_PARAM_ENABLE_PARTICIPANT_PORTAL=true で participantPortal が runtimeConfig 付きで返るべき", () => {
    const cfg = resolveAppConfig({
      env: baseEnv({
        CDK_PARAM_ENABLE_PARTICIPANT_PORTAL: "true",
        CDK_PARAM_PARTICIPANT_PORTAL_EVENT_TITLE: "Test Event",
      }),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(cfg.enableParticipantPortal).toBe(true);
    expect(cfg.participantPortal).toBeDefined();
  });

  it("CDK_PARAM_ENABLE_PARTICIPANT_PORTAL が無ければ participantPortal は undefined", () => {
    const cfg = resolveAppConfig({
      env: baseEnv(),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(cfg.enableParticipantPortal).toBe(false);
    expect(cfg.participantPortal).toBeUndefined();
  });

  it("adminConsoleHostingInputs は 3 つの env (apiUrl / cognitoDomain / userClientId) が揃ったときだけ object を返すべき (phase 2 gate)", () => {
    const noinputs = resolveAppConfig({
      env: baseEnv(),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(noinputs.adminConsoleHostingInputs).toBeUndefined();

    const partial = resolveAppConfig({
      env: baseEnv({ CDK_PARAM_CONTROL_PLANE_API_URL: "https://api" }),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(partial.adminConsoleHostingInputs).toBeUndefined();

    const all = resolveAppConfig({
      env: baseEnv({
        CDK_PARAM_CONTROL_PLANE_API_URL: "https://api",
        CDK_PARAM_CONTROL_PLANE_COGNITO_DOMAIN: "https://cog",
        CDK_PARAM_CONTROL_PLANE_USER_CLIENT_ID: "abc",
      }),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(all.adminConsoleHostingInputs).toMatchObject({
      apiUrl: "https://api",
      cognitoDomain: "https://cog",
      userClientId: "abc",
    });
  });

  it("CDK_PARAM_IDP_NAME / SYSTEM_ADMIN_ROLE_NAME のデフォルトを process.env に注入すべき (SBT ref-arch 互換)", () => {
    const env = baseEnv();
    expect(env.CDK_PARAM_IDP_NAME).toBeUndefined();
    expect(env.CDK_PARAM_SYSTEM_ADMIN_ROLE_NAME).toBeUndefined();
    resolveAppConfig({
      env,
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(env.CDK_PARAM_IDP_NAME).toBe("COGNITO");
    expect(env.CDK_PARAM_SYSTEM_ADMIN_ROLE_NAME).toBe("SystemAdmin");
  });

  // Issue #952 / PR-957 CodeRabbit follow-up: schema は `monthlyCostLimitUsd` に数値文字列を
  // 許容する (`${MONTHLY_COST_LIMIT_USD:-50}` で `"50"` が JSON に入る) ため、 resolve は
  // string を Number として扱う必要がある。 env override は process.env 直読みのため本
  // test では config.json default (= "50") が正しく Number 化されることだけを pin する。
  it("monthlyCostLimitUsd は config.json の string '50' を number 50 に正規化するべき", () => {
    const cfg = resolveAppConfig({
      env: baseEnv(),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(cfg.monthlyCostLimitUsd).toBe(50);
    expect(typeof cfg.monthlyCostLimitUsd).toBe("number");
  });
});

describe("resolveApiKeyValue", () => {
  it("env に値があればそれをそのまま返すべき", () => {
    const value = resolveApiKeyValue({
      env: { MY_KEY: "from-env" },
      envVar: "MY_KEY",
      tier: "basic",
      environment: "development",
      appNameLower: "tenkacloud",
      isProductionLike: false,
    });
    expect(value).toBe("from-env");
  });

  it("dev 環境では deterministic default を返すべき", () => {
    const value = resolveApiKeyValue({
      env: {},
      envVar: "MY_KEY",
      tier: "platinum",
      environment: "development",
      appNameLower: "tenkacloud",
      isProductionLike: false,
    });
    expect(value).toBe("tenkacloud-development-platinum-tier-key-default-do-not-share");
  });

  it("production / staging 等の isProductionLike では env 必須で throw すべき", () => {
    expect(() =>
      resolveApiKeyValue({
        env: {},
        envVar: "MY_KEY",
        tier: "platinum",
        environment: "production",
        appNameLower: "tenkacloud",
        isProductionLike: true,
      }),
    ).toThrow(/MY_KEY が production 環境で未設定/);
  });
});
