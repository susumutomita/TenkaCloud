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
  it("should throw when CDK_PARAM_SYSTEM_ADMIN_EMAIL is unset", () => {
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

  it("should default to pooled and set isPooledDeploy=true when CDK_PARAM_TENANT_ID is unset", () => {
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

  it("should fall back tenantName to tenantId when CDK_PARAM_TENANT_ID is a ULID and CDK_PARAM_TENANT_NAME is unset", () => {
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

  it("should prefer CDK_PARAM_TENANT_NAME when set (downstream of #748 fix)", () => {
    const cfg = resolveAppConfig({
      env: baseEnv({ CDK_PARAM_TENANT_ID: "t-1", CDK_PARAM_TENANT_NAME: "Acme Corp" }),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(cfg.tenantName).toBe("Acme Corp");
  });

  it("DynamoDB billing mode default should be PROVISIONED + 1/1 capacity (Free Tier safety)", () => {
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

  it("namePrefix should be built as `{appNameLower}-{environment}`", () => {
    const cfg = resolveAppConfig({
      env: baseEnv(),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(cfg.namePrefix).toBe("tenkacloud-development");
  });

  it("apiKeySSMParameterNames should return keyId / value names for all 4 tiers including namePrefix", () => {
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

  it("should throw if CDK_PARAM_DEPLOY_CONCURRENT_BUILD_LIMIT is not an integer", () => {
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

  it("should return undefined when CDK_PARAM_DEPLOY_CONCURRENT_BUILD_LIMIT is unset (defer to account-level quota)", () => {
    const cfg = resolveAppConfig({
      env: baseEnv(),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(cfg.deployConcurrentBuildLimit).toBeUndefined();
  });

  it("should resolve CDK_PARAM_DEPLOY_ALLOWED_CIDRS as the deploy-time app ingress allowlist", () => {
    const cfg = resolveAppConfig({
      env: baseEnv({
        CDK_PARAM_DEPLOY_ALLOWED_CIDRS: " 198.51.100.10/32,203.0.113.0/24 ",
      }),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(cfg.deployAllowedCidrs).toEqual(["198.51.100.10/32", "203.0.113.0/24"]);
  });

  it("should reject malformed CDK_PARAM_DEPLOY_ALLOWED_CIDRS entries", () => {
    expect(() =>
      resolveAppConfig({
        env: baseEnv({ CDK_PARAM_DEPLOY_ALLOWED_CIDRS: "198.51.100.10/33" }),
        binDir: BIN_DIR,
        fs: fsAlwaysMissing,
        dotenvConfig: noopDotenv,
        discoverProblems: stubProblems,
      }),
    ).toThrow(/CDK_PARAM_DEPLOY_ALLOWED_CIDRS/);
  });

  it("should return participantPortal with runtimeConfig when CDK_PARAM_ENABLE_PARTICIPANT_PORTAL=true", () => {
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

  it("Issue #1031: adminConsoleHostingInputs / adminConsoleOriginForCors fields should be removed from AppConfig", () => {
    // admin-console-hosting は backend URL の cross-stack ref で立つようになり、 env-var 経由の
    // gate は廃止された。 AppConfig 出力に該当 field が含まれないことで env-var 経路 regression を防ぐ。
    const cfg = resolveAppConfig({
      env: baseEnv({
        CDK_PARAM_CONTROL_PLANE_API_URL: "https://api",
        CDK_PARAM_CONTROL_PLANE_COGNITO_DOMAIN: "https://cog",
        CDK_PARAM_CONTROL_PLANE_USER_CLIENT_ID: "abc",
        CDK_PARAM_ADMIN_CONSOLE_ORIGIN: "https://admin.example.com",
      }),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect((cfg as Record<string, unknown>).adminConsoleHostingInputs).toBeUndefined();
    expect((cfg as Record<string, unknown>).adminConsoleOriginForCors).toBeUndefined();
  });

  it("should inject defaults for CDK_PARAM_IDP_NAME / SYSTEM_ADMIN_ROLE_NAME into process.env (SBT ref-arch compatible)", () => {
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
  // 許容する (`${MONTHLY_COST_LIMIT_USD:-0}` で `"50"` のような string が JSON に入る) ため、
  // resolve は string を Number として扱う必要がある。
  //
  // Issue #2961 で config.json の既定が 0 (= OFF) になったので、正規化そのものを見るには
  // 値を与える必要がある。展開は `loadConfig` が process.env を直読みするのでそちらに置く。
  it("monthlyCostLimitUsd should normalize a numeric string from config.json to a number", () => {
    const previous = process.env.MONTHLY_COST_LIMIT_USD;
    process.env.MONTHLY_COST_LIMIT_USD = "50";
    try {
      const cfg = resolveAppConfig({
        env: baseEnv(),
        binDir: BIN_DIR,
        fs: fsAlwaysMissing,
        dotenvConfig: noopDotenv,
        discoverProblems: stubProblems,
      });
      expect(cfg.monthlyCostLimitUsd).toBe(50);
      expect(typeof cfg.monthlyCostLimitUsd).toBe("number");
    } finally {
      if (previous === undefined) delete process.env.MONTHLY_COST_LIMIT_USD;
      else process.env.MONTHLY_COST_LIMIT_USD = previous;
    }
  });

  // Issue #2959: RETAIN は opt-in。他の boolean parameter と向きが逆なので、"true" 以外
  // (未設定 / "false" / "1" / "TRUE") がすべて DESTROY 側に倒れることを見る。ここが緩むと
  // 「消えるつもりが残る」= destroy 後に PROVISIONED 課金が続く元の問題に戻る。
  it.each([
    ["unset", undefined, false],
    ["false", "false", false],
    ["1", "1", false],
    ["TRUE", "TRUE", false],
    ["true", "true", true],
  ])("retainDataTables should be %s -> %s", (_label, value, expected) => {
    const env = baseEnv();
    if (value !== undefined) env.CDK_PARAM_RETAIN_DATA_TABLES = value;
    const cfg = resolveAppConfig({
      env,
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(cfg.retainDataTables).toBe(expected);
  });

  // Issue #2961: 何も設定しなければコスト監視は立たない。0 は「limit 0 ドル」ではなく無効を意味し、
  // `parsed > 0` の判定で undefined に倒れる。ここが 0 以外に戻ると、購読確認メールが deploy の
  // たびに届く状態に逆戻りする。
  it("monthlyCostLimitUsd should be undefined by default so cost monitoring stays opt-in", () => {
    const cfg = resolveAppConfig({
      env: baseEnv(),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(cfg.monthlyCostLimitUsd).toBeUndefined();
  });

  it("should keep ops monitoring disabled when CDK_PARAM_OPS_ALERT_EMAIL is unset", () => {
    const cfg = resolveAppConfig({
      env: baseEnv(),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(cfg.opsMonitoring).toBeUndefined();
  });

  it("should enable ops monitoring from CDK_PARAM_OPS_ALERT_EMAIL with the default monthly cap", () => {
    const cfg = resolveAppConfig({
      env: baseEnv({ CDK_PARAM_OPS_ALERT_EMAIL: "ops@example.com" }),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(cfg.opsMonitoring).toEqual({
      alertEmail: "ops@example.com",
      monthlyCostLimitUsd: 10,
      budgetThresholdPercent: 100,
    });
  });

  it("should override ops budget amount and threshold from CDK_PARAM env", () => {
    const cfg = resolveAppConfig({
      env: baseEnv({
        CDK_PARAM_OPS_ALERT_EMAIL: "ops@example.com",
        CDK_PARAM_OPS_MONTHLY_COST_LIMIT_USD: "25",
        CDK_PARAM_OPS_BUDGET_THRESHOLD_PERCENT: "90",
      }),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(cfg.opsMonitoring).toEqual({
      alertEmail: "ops@example.com",
      monthlyCostLimitUsd: 25,
      budgetThresholdPercent: 90,
    });
  });

  it("should fall back to literal ops defaults when the environment has no config.json", () => {
    const cfg = resolveAppConfig({
      env: baseEnv({
        CDK_PARAM_ENVIRONMENT: "staging",
        CDK_PARAM_OPS_ALERT_EMAIL: "ops@example.com",
        // staging is production-like: API key parameters must be provided explicitly
        CDK_PARAM_API_KEY_PLATINUM_TIER_PARAMETER: "test-platinum",
        CDK_PARAM_API_KEY_PREMIUM_TIER_PARAMETER: "test-premium",
        CDK_PARAM_API_KEY_STANDARD_TIER_PARAMETER: "test-standard",
        CDK_PARAM_API_KEY_BASIC_TIER_PARAMETER: "test-basic",
      }),
      binDir: BIN_DIR,
      fs: fsAlwaysMissing,
      dotenvConfig: noopDotenv,
      discoverProblems: stubProblems,
    });
    expect(cfg.opsMonitoring).toEqual({
      alertEmail: "ops@example.com",
      monthlyCostLimitUsd: 10,
      budgetThresholdPercent: 100,
    });
  });

  it("should throw when CDK_PARAM_OPS_MONTHLY_COST_LIMIT_USD is not a positive number", () => {
    expect(() =>
      resolveAppConfig({
        env: baseEnv({
          CDK_PARAM_OPS_ALERT_EMAIL: "ops@example.com",
          CDK_PARAM_OPS_MONTHLY_COST_LIMIT_USD: "-5",
        }),
        binDir: BIN_DIR,
        fs: fsAlwaysMissing,
        dotenvConfig: noopDotenv,
        discoverProblems: stubProblems,
      }),
    ).toThrow(/CDK_PARAM_OPS_MONTHLY_COST_LIMIT_USD must be a positive number/);
  });

  it("should throw when CDK_PARAM_OPS_BUDGET_THRESHOLD_PERCENT exceeds 100", () => {
    expect(() =>
      resolveAppConfig({
        env: baseEnv({
          CDK_PARAM_OPS_ALERT_EMAIL: "ops@example.com",
          CDK_PARAM_OPS_BUDGET_THRESHOLD_PERCENT: "150",
        }),
        binDir: BIN_DIR,
        fs: fsAlwaysMissing,
        dotenvConfig: noopDotenv,
        discoverProblems: stubProblems,
      }),
    ).toThrow(/CDK_PARAM_OPS_BUDGET_THRESHOLD_PERCENT must be a positive number and <= 100/);
  });
});

describe("resolveApiKeyValue", () => {
  it("should return env as-is when set", () => {
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

  it("should return a deterministic default in the dev environment", () => {
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

  it("should throw on missing env in isProductionLike (production / staging etc.)", () => {
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

  // Issue #1340 Phase 2: per-tenant SAML env を resolveAppConfig が正しく parse して AppConfig に
  // 載せること。 未設定なら空配列、 不正値は fail-loud。
  describe("tenant SAML env (#1340)", () => {
    it("should default tenantSamlIdps / tenantSamlAdminAllowlist to empty when env is unset", () => {
      const cfg = resolveAppConfig({
        env: baseEnv(),
        binDir: BIN_DIR,
        fs: fsAlwaysMissing,
        dotenvConfig: noopDotenv,
        discoverProblems: stubProblems,
      });
      expect(cfg.tenantSamlIdps).toEqual([]);
      expect(cfg.tenantSamlAdminAllowlist).toEqual([]);
    });

    it("should parse TENANT_SAML_IDPS JSON array and TENANT_SAML_ADMIN_ALLOWLIST comma list", () => {
      const cfg = resolveAppConfig({
        env: baseEnv({
          TENANT_SAML_IDPS: JSON.stringify([
            {
              name: "tenant-entra",
              metadataUrl: "https://meta.example",
              emailDomains: ["acme.example"],
            },
          ]),
          TENANT_SAML_ADMIN_ALLOWLIST: "tenant-entra/admin@acme.example",
        }),
        binDir: BIN_DIR,
        fs: fsAlwaysMissing,
        dotenvConfig: noopDotenv,
        discoverProblems: stubProblems,
      });
      expect(cfg.tenantSamlIdps).toHaveLength(1);
      expect(cfg.tenantSamlIdps[0]?.name).toBe("tenant-entra");
      expect(cfg.tenantSamlAdminAllowlist).toEqual(["tenant-entra/admin@acme.example"]);
    });

    it("should fail-loud with the TENANT_SAML_IDPS env name when JSON is invalid (= ops debuggability)", () => {
      expect(() =>
        resolveAppConfig({
          env: baseEnv({ TENANT_SAML_IDPS: "not-json" }),
          binDir: BIN_DIR,
          fs: fsAlwaysMissing,
          dotenvConfig: noopDotenv,
          discoverProblems: stubProblems,
        }),
      ).toThrow(/TENANT_SAML_IDPS/);
    });
  });
});
