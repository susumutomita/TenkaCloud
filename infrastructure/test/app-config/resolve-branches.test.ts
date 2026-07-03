import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveApiKeyValue, resolveAppConfig } from "../../lib/app-config/resolve";

/**
 * Issue #1418: app-config/resolve.ts は 77% branch だった。 既存 resolve.test の happy path に加え、
 * env / fs / dotenv / input 駆動の fallback 枝 (loadEnvironment fs-exists, injectSbtDefaults
 * already-set, stackEnv, dynamo env capacities, participantPortal, deployConcurrentBuildLimit,
 * resolveApiKeyValue env/prod) を pin する。 config.json 値依存の枝は file 固定なので対象外。
 */
const BIN_DIR = path.resolve(__dirname, "..", "..", "bin");
const stubProblems = () => ({
  catalog: [],
  scoring: {},
  endpoints: {},
  phases: {},
  visibility: [],
});
const baseEnv = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  CDK_PARAM_SYSTEM_ADMIN_EMAIL: "admin@example.com",
  CDK_PARAM_S3_BUCKET_NAME: "test-bucket",
  CDK_SOURCE_NAME: "source.zip",
  CDK_PARAM_COMMIT_ID: "abcdef",
  ...over,
});
const resolve = (
  env: NodeJS.ProcessEnv,
  opts: { fs?: { existsSync: () => boolean }; dotenvConfig?: () => void } = {},
) =>
  resolveAppConfig({
    env,
    binDir: BIN_DIR,
    fs: opts.fs ?? { existsSync: () => false },
    dotenvConfig: opts.dotenvConfig ?? (() => undefined),
    discoverProblems: stubProblems,
  });

describe("resolveAppConfig env/fs/input-driven branches", () => {
  it("should load the env file and invoke dotenvConfig when it exists", () => {
    const dotenvConfig = vi.fn();
    resolve(baseEnv(), { fs: { existsSync: () => true }, dotenvConfig });
    expect(dotenvConfig).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.any(String) }),
    );
  });

  it("should not overwrite SBT defaults that are already set", () => {
    const env = baseEnv({ CDK_PARAM_IDP_NAME: "CUSTOM", CDK_PARAM_SYSTEM_ADMIN_ROLE_NAME: "Boss" });
    resolve(env);
    expect(env.CDK_PARAM_IDP_NAME).toBe("CUSTOM");
    expect(env.CDK_PARAM_SYSTEM_ADMIN_ROLE_NAME).toBe("Boss");
  });

  it("should populate stackEnv when both AWS account and region are set", () => {
    const cfg = resolve(
      baseEnv({ CDK_PARAM_AWS_REGION: "ap-northeast-1", CDK_PARAM_AWS_ACCOUNT_ID: "123456789012" }),
    );
    expect(cfg.stackEnv).toEqual({ env: { account: "123456789012", region: "ap-northeast-1" } });
  });

  it("should use env-provided DynamoDB capacities + KMS window", () => {
    const cfg = resolve(
      baseEnv({
        CDK_PARAM_DYNAMODB_READ_CAPACITY: "5",
        CDK_PARAM_DYNAMODB_WRITE_CAPACITY: "7",
        CDK_PARAM_KMS_PENDING_WINDOW_DAYS: "10",
      }),
    );
    expect(cfg.dynamoReadCapacity).toBe(5);
    expect(cfg.dynamoWriteCapacity).toBe(7);
    expect(cfg.kmsPendingWindowInDays).toBe(10);
  });

  it("should enable the participant portal with a custom event title", () => {
    const cfg = resolve(
      baseEnv({
        CDK_PARAM_ENABLE_PARTICIPANT_PORTAL: "true",
        CDK_PARAM_PARTICIPANT_PORTAL_EVENT_TITLE: "Spring Cup",
        CDK_PARAM_AWS_REGION: "us-east-1",
      }),
    );
    expect(cfg.enableParticipantPortal).toBe(true);
    expect(cfg.participantPortal?.runtimeConfig).toMatchObject({
      eventTitle: "Spring Cup",
      eventRegion: "us-east-1",
    });
  });

  it("should enable the participant portal with the default-dev-mock when no title is given", () => {
    const cfg = resolve(baseEnv({ CDK_PARAM_ENABLE_PARTICIPANT_PORTAL: "true" }));
    expect(cfg.participantPortal?.runtimeConfig).toBe("default-dev-mock");
  });

  it("should leave the participant portal undefined when disabled", () => {
    const cfg = resolve(baseEnv());
    expect(cfg.enableParticipantPortal).toBe(false);
    expect(cfg.participantPortal).toBeUndefined();
  });

  it("should parse a valid concurrent build limit", () => {
    expect(
      resolve(baseEnv({ CDK_PARAM_DEPLOY_CONCURRENT_BUILD_LIMIT: "4" })).deployConcurrentBuildLimit,
    ).toBe(4);
  });

  it("should leave the concurrent build limit undefined when blank", () => {
    expect(
      resolve(baseEnv({ CDK_PARAM_DEPLOY_CONCURRENT_BUILD_LIMIT: "  " }))
        .deployConcurrentBuildLimit,
    ).toBeUndefined();
  });

  it("should parse a valid deploy quota by tier (#1766)", () => {
    expect(
      resolve(baseEnv({ CDK_PARAM_DEPLOY_QUOTA_BY_TIER: '{"basic":2,"advanced":5,"platinum":10}' }))
        .deployQuotaByTier,
    ).toEqual({ basic: 2, advanced: 5, platinum: 10 });
  });

  it("should leave the deploy quota undefined when unset (quota disabled, #1766)", () => {
    expect(resolve(baseEnv()).deployQuotaByTier).toBeUndefined();
  });

  it("should throw loudly on a broken deploy quota value instead of silently disabling (#1766)", () => {
    expect(() => resolve(baseEnv({ CDK_PARAM_DEPLOY_QUOTA_BY_TIER: '{"basic":2}' }))).toThrow(
      /DEPLOY_QUOTA_BY_TIER/,
    );
  });

  it("should throw on a non-integer concurrent build limit", () => {
    expect(() => resolve(baseEnv({ CDK_PARAM_DEPLOY_CONCURRENT_BUILD_LIMIT: "4.5" }))).toThrow(
      /整数/,
    );
  });

  it("should default useBulkDistributedMap to false when unset (#2232)", () => {
    expect(resolve(baseEnv()).useBulkDistributedMap).toBe(false);
  });

  it("should enable useBulkDistributedMap only when CDK_PARAM_BULK_DEPLOY_VIA_DISTRIBUTED_MAP is exactly 'true' (#2232)", () => {
    expect(
      resolve(baseEnv({ CDK_PARAM_BULK_DEPLOY_VIA_DISTRIBUTED_MAP: "true" })).useBulkDistributedMap,
    ).toBe(true);
    expect(
      resolve(baseEnv({ CDK_PARAM_BULK_DEPLOY_VIA_DISTRIBUTED_MAP: "yes" })).useBulkDistributedMap,
    ).toBe(false);
  });

  it("should default deployViaLambda to false when unset (#2291 no regression)", () => {
    expect(resolve(baseEnv()).deployViaLambda).toBe(false);
  });

  it("should enable deployViaLambda only when CDK_PARAM_DEPLOY_VIA_LAMBDA is exactly 'true' (#2291)", () => {
    expect(resolve(baseEnv({ CDK_PARAM_DEPLOY_VIA_LAMBDA: "true" })).deployViaLambda).toBe(true);
    // 設定ミス値は在来 CodeBuild 経路のまま (= fail-safe、追加リソースを誤って生やさない)。
    expect(resolve(baseEnv({ CDK_PARAM_DEPLOY_VIA_LAMBDA: "yes" })).deployViaLambda).toBe(false);
    expect(resolve(baseEnv({ CDK_PARAM_DEPLOY_VIA_LAMBDA: "1" })).deployViaLambda).toBe(false);
  });

  it("should default auditLogEnabled to true when unset (#2311 no regression)", () => {
    expect(resolve(baseEnv()).auditLogEnabled).toBe(true);
  });

  it("should disable auditLogEnabled only when CDK_PARAM_AUDIT_LOG_ENABLED is exactly 'false' (#2311)", () => {
    expect(resolve(baseEnv({ CDK_PARAM_AUDIT_LOG_ENABLED: "false" })).auditLogEnabled).toBe(false);
    // 明示 "true" / 設定ミス値 ("0" 等) は enabled のまま (= 監査を誤って消さない fail-safe)。
    expect(resolve(baseEnv({ CDK_PARAM_AUDIT_LOG_ENABLED: "true" })).auditLogEnabled).toBe(true);
    expect(resolve(baseEnv({ CDK_PARAM_AUDIT_LOG_ENABLED: "0" })).auditLogEnabled).toBe(true);
  });

  it("should default controlDataBackend to 'dynamodb' when unset (#2290 no regression)", () => {
    expect(resolve(baseEnv()).controlDataBackend).toBe("dynamodb");
    // 空文字 / 空白のみも default 扱い (= 在来 DDB 経路、byte 互換)。
    expect(resolve(baseEnv({ CDK_PARAM_CONTROL_DATA_BACKEND: "" })).controlDataBackend).toBe(
      "dynamodb",
    );
    expect(resolve(baseEnv({ CDK_PARAM_CONTROL_DATA_BACKEND: "  " })).controlDataBackend).toBe(
      "dynamodb",
    );
  });

  it("should accept turso / sql and normalize case for controlDataBackend (#2290)", () => {
    expect(resolve(baseEnv({ CDK_PARAM_CONTROL_DATA_BACKEND: "turso" })).controlDataBackend).toBe(
      "turso",
    );
    expect(resolve(baseEnv({ CDK_PARAM_CONTROL_DATA_BACKEND: "sql" })).controlDataBackend).toBe(
      "sql",
    );
    // 大文字混在は lowercase 正規化する。
    expect(resolve(baseEnv({ CDK_PARAM_CONTROL_DATA_BACKEND: "Turso" })).controlDataBackend).toBe(
      "turso",
    );
    expect(
      resolve(baseEnv({ CDK_PARAM_CONTROL_DATA_BACKEND: "DynamoDB" })).controlDataBackend,
    ).toBe("dynamodb");
  });

  it("should throw loudly on an unknown controlDataBackend value instead of silently defaulting (#2290)", () => {
    expect(() => resolve(baseEnv({ CDK_PARAM_CONTROL_DATA_BACKEND: "postgres" }))).toThrow(
      /CDK_PARAM_CONTROL_DATA_BACKEND must be one of dynamodb\|turso\|sql/,
    );
  });

  it("should fall back to real problem discovery when no discoverProblems stub is injected", () => {
    // exercises discoverAppProblems' production branch (real problems/ scan via the submodule).
    const cfg = resolveAppConfig({
      env: baseEnv(),
      binDir: BIN_DIR,
      fs: { existsSync: () => false },
      dotenvConfig: () => undefined,
    });
    expect(cfg.problems.catalog).toBeDefined();
    expect(cfg.problems.scoring).toBeDefined();
  });
});

describe("resolveApiKeyValue", () => {
  const base = {
    tier: "basic",
    environment: "development",
    appNameLower: "tc",
    isProductionLike: false,
  };
  it("should return the env-provided value when present", () => {
    expect(resolveApiKeyValue({ ...base, env: { K: "secret" }, envVar: "K" })).toBe("secret");
  });
  it("should return a deterministic dev default when unset (non-production)", () => {
    expect(resolveApiKeyValue({ ...base, env: {}, envVar: "K" })).toBe(
      "tc-development-basic-tier-key-default-do-not-share",
    );
  });
  it("should throw when unset in a production-like environment", () => {
    expect(() =>
      resolveApiKeyValue({
        ...base,
        env: {},
        envVar: "K",
        environment: "production",
        isProductionLike: true,
      }),
    ).toThrow(/production/);
  });
});
