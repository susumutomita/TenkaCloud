import * as cdk from "aws-cdk-lib";
import { describe, expect, it } from "vitest";
import { resolveAppConfig } from "../../lib/app-config/resolve";
import { buildTenkaCloudApp } from "../../lib/app-wiring/wire";

/**
 * Issue #2192: `buildTenkaCloudApp` (wire.ts) はヘッダで「cdk synth 結果が変わらない」ことを
 * invariant として宣言しているが、機械保証が無かった。本テストは App レベルの synth を
 * 3 つの粒度で pin する:
 *
 *   1. stack ID の集合 (= CFn physical stack name。変わると新 stack 扱い = 旧 stack orphan)
 *   2. stack 間の依存辺 (= deploy 順序。消えると race、増えると deploy 遅延/循環リスク)
 *   3. 各 stack の logical ID 集合 (= 変わると CFn が REPLACE/DELETE を発行しうる)
 *
 * 後続の CDK リファクタ (SPA hosting builder / NodejsFunction factory / Lite 配線統合) は
 * すべて「本テストが無変更で緑のまま」であることを Physical impact: NO-OP の根拠にする。
 * 意図して stack 構成を変える PR だけが snapshot を更新してよい。
 *
 * synth は `aws:cdk:bundling-stacks: []` でアセットの bundling を無効化して実行する
 * (SBT の PythonFunction が Docker を要求するため)。bundling はアセット内容にのみ影響し、
 * logical ID / 依存辺には影響しない。
 */

const stubProblems = () => ({
  catalog: [],
  scoring: {},
  writeups: {},
  endpoints: {},
  phases: {},
  visibility: [],
  runtimes: {},
  disruptions: {},
  coordination: {},
  coordinationBundles: {},
});

const baseEnv = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  CDK_PARAM_SYSTEM_ADMIN_EMAIL: "admin@example.com",
  CDK_PARAM_S3_BUCKET_NAME: "test-bucket",
  CDK_SOURCE_NAME: "source.zip",
  CDK_PARAM_COMMIT_ID: "abcdef",
  CDK_PARAM_TENANT_ID: "pooled",
  ...over,
});

function synthApp(envOverrides: Record<string, string | undefined> = {}) {
  const config = resolveAppConfig({
    env: baseEnv(envOverrides),
    binDir: `${__dirname}/../../bin`,
    fs: { existsSync: () => false },
    dotenvConfig: () => undefined,
    discoverProblems: stubProblems,
  });
  const app = new cdk.App({ autoSynth: false, context: { "aws:cdk:bundling-stacks": [] } });
  buildTenkaCloudApp(app, config);
  return app.synth();
}

describe("buildTenkaCloudApp synth regression (issue #2192)", () => {
  const assembly = synthApp();

  it("should keep the exact set of stack IDs (development = no env suffix)", () => {
    const stackIds = assembly.stacks.map((s) => s.stackName).sort();
    expect(stackIds).toEqual([
      "tenkacloud-admin-console-hosting",
      "tenkacloud-admin-console-insight",
      "tenkacloud-admin-console-runtime-config",
      "tenkacloud-bootstrap",
      "tenkacloud-challenge-payload",
      "tenkacloud-control-plane",
      "tenkacloud-observability",
      "tenkacloud-problem-deploy",
      "tenkacloud-saas-pipeline",
      "tenkacloud-tenant-template-pooled",
    ]);
  });

  it("should keep the deploy-order dependency edges between stacks", () => {
    const edges = Object.fromEntries(
      assembly.stacks
        .map((s) => [s.stackName, s.dependencies.map((d) => d.id).sort()] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    expect(edges).toMatchSnapshot();
  });

  it("should keep every stack's logical ID set (REPLACE/DELETE guard)", () => {
    for (const stack of assembly.stacks) {
      const resources = (stack.template as { Resources?: Record<string, unknown> }).Resources;
      const logicalIds = Object.keys(resources ?? {}).sort();
      expect(logicalIds).toMatchSnapshot(stack.stackName);
    }
  });

  it("should suffix every stack ID for non-development environments (issue #992)", () => {
    const staging = synthApp({
      CDK_PARAM_ENVIRONMENT: "staging",
      CDK_PARAM_API_KEY_PLATINUM_TIER_PARAMETER: "platinum-key",
      CDK_PARAM_API_KEY_PREMIUM_TIER_PARAMETER: "premium-key",
      CDK_PARAM_API_KEY_STANDARD_TIER_PARAMETER: "standard-key",
      CDK_PARAM_API_KEY_BASIC_TIER_PARAMETER: "basic-key",
    });
    for (const stack of staging.stacks) {
      expect(stack.stackName).toMatch(/-staging$/);
    }
  });
});
