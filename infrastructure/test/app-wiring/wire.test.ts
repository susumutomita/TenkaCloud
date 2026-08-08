import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveAppConfig } from "../../lib/app-config/resolve";
import { buildTenkaCloudApp } from "../../lib/app-wiring/wire";

/**
 * Issue #2192: `buildTenkaCloudApp` (= 全 stack 配線) の regression 網。
 *
 * wire.ts はヘッダで「stack の生成順 + ID + 依存関係を保ち cdk synth 結果が変わらない」ことを
 * invariant として約束しているが、これまで機械保証が無かった。本テストは synth **不要** で
 * 取れる configuration-time の不変条件 (stack ID 集合 / env suffix 規則 / deploy 依存 edge 集合)
 * を pin する。
 *
 * full `app.synth()` を行わないのは意図的: ControlPlaneStack (SBT) は Python Lambda の
 * Docker bundling を要求し CI では synth できない (test/helpers.ts 参照)。 logical ID
 * レベルの保護は各 stack の既存 `Template.fromStack` テスト側が担う。
 */
const BIN_DIR = path.resolve(__dirname, "..", "..", "bin");
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** hosting 系 stack は construct 時に SPA の dist/ 実在を要求する (既存 hosting テストと同じ手当)。 */
function ensurePlaceholderDist(appName: string): void {
  const distDir = path.join(REPO_ROOT, "apps", appName, "dist");
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(distDir, "index.html"),
      "<!doctype html><html><body>placeholder</body></html>",
    );
  }
}

const stubProblems = () => ({
  catalog: [],
  scoring: {},
  endpoints: {},
  phases: {},
  visibility: [],
});

function buildApp(envOverrides: Record<string, string> = {}): cdk.App {
  const config = resolveAppConfig({
    env: {
      CDK_PARAM_SYSTEM_ADMIN_EMAIL: "admin@example.com",
      CDK_PARAM_S3_BUCKET_NAME: "test-bucket",
      CDK_SOURCE_NAME: "source.zip",
      CDK_PARAM_COMMIT_ID: "abcdef",
      CDK_PARAM_AWS_REGION: "ap-northeast-1",
      CDK_PARAM_AWS_ACCOUNT_ID: "123456789012",
      ...envOverrides,
    },
    binDir: BIN_DIR,
    fs: { existsSync: () => false },
    dotenvConfig: () => undefined,
    discoverProblems: stubProblems,
  });
  // SBT の Python Lambda bundling (要 Docker) を construct 時に走らせないため、
  // bundling を全 stack で skip する (asset は placeholder になる。 synth はしない)。
  const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
  buildTenkaCloudApp(app, config);
  return app;
}

function stackIds(app: cdk.App): string[] {
  return app.node.children
    .filter(cdk.Stack.isStack)
    .map((stack) => stack.node.id)
    .sort();
}

function dependencyEdges(app: cdk.App): string[] {
  return app.node.children
    .filter(cdk.Stack.isStack)
    .flatMap((stack) => stack.dependencies.map((dep) => `${stack.node.id} -> ${dep.node.id}`))
    .sort();
}

/**
 * development の SaaS 構成で立つ stack ID の全集合 (= 旧 deploy 互換の suffix 無し ID)。
 * challenge-payload は environments/development/config.json の `challengePayloadConfig` により立つ。
 */
const DEVELOPMENT_STACK_IDS = [
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
];

describe("buildTenkaCloudApp", () => {
  beforeAll(() => {
    ensurePlaceholderDist("admin-console");
    ensurePlaceholderDist("application-admin-console");
    ensurePlaceholderDist("participant-portal");
  });

  it("should create exactly the SaaS stack set with unsuffixed IDs in development", () => {
    const app = buildApp();
    expect(stackIds(app)).toEqual(DEVELOPMENT_STACK_IDS);
  });

  it("should suffix every stack ID with the environment outside development (#992)", () => {
    const app = buildApp({
      CDK_PARAM_ENVIRONMENT: "staging",
      // production-like 環境では API key parameter が必須 (resolveApiKeyValue が fail-loud)。
      CDK_PARAM_API_KEY_PLATINUM_TIER_PARAMETER: "test-platinum",
      CDK_PARAM_API_KEY_PREMIUM_TIER_PARAMETER: "test-premium",
      CDK_PARAM_API_KEY_STANDARD_TIER_PARAMETER: "test-standard",
      CDK_PARAM_API_KEY_BASIC_TIER_PARAMETER: "test-basic",
    });
    // staging の config.json は challengePayloadConfig を定義しないため当該 stack は立たない。
    expect(stackIds(app)).toEqual(
      DEVELOPMENT_STACK_IDS.filter((id) => id !== "tenkacloud-challenge-payload")
        .map((id) => `${id}-staging`)
        .sort(),
    );
  });

  it("should pin the deploy-order dependency edges between stacks", () => {
    const app = buildApp();
    // registerStackDependencies の明示 edge + cross-stack ref 由来の暗黙 edge を合わせた全集合。
    // ここが変わる = deploy 順序 / cross-stack 参照の配線が変わったということ。意図的な変更の
    // ときだけ、 PR にその旨を明記して期待値を更新する。
    expect(dependencyEdges(app)).toEqual(
      [
        "tenkacloud-control-plane -> tenkacloud-admin-console-hosting",
        "tenkacloud-problem-deploy -> tenkacloud-challenge-payload",
        "tenkacloud-tenant-template-pooled -> tenkacloud-problem-deploy",
        "tenkacloud-tenant-template-pooled -> tenkacloud-bootstrap",
        "tenkacloud-admin-console-insight -> tenkacloud-control-plane",
        "tenkacloud-admin-console-insight -> tenkacloud-problem-deploy",
        "tenkacloud-admin-console-insight -> tenkacloud-bootstrap",
        "tenkacloud-admin-console-insight -> tenkacloud-tenant-template-pooled",
        "tenkacloud-observability -> tenkacloud-control-plane",
        "tenkacloud-observability -> tenkacloud-problem-deploy",
        "tenkacloud-observability -> tenkacloud-admin-console-insight",
        "tenkacloud-observability -> tenkacloud-bootstrap",
        "tenkacloud-observability -> tenkacloud-tenant-template-pooled",
        "tenkacloud-observability -> tenkacloud-saas-pipeline",
        "tenkacloud-admin-console-runtime-config -> tenkacloud-observability",
        "tenkacloud-admin-console-runtime-config -> tenkacloud-admin-console-hosting",
        "tenkacloud-admin-console-runtime-config -> tenkacloud-control-plane",
        "tenkacloud-admin-console-runtime-config -> tenkacloud-admin-console-insight",
        "tenkacloud-admin-console-runtime-config -> tenkacloud-tenant-template-pooled",
        "tenkacloud-admin-console-runtime-config -> tenkacloud-saas-pipeline",
        "tenkacloud-admin-console-runtime-config -> tenkacloud-problem-deploy",
      ].sort(),
    );
  });

  it("should skip the challenge-payload stack when the legacy bucket override is set", () => {
    const app = buildApp({ CDK_PARAM_CHALLENGE_PAYLOAD_BUCKET: "external-payload-bucket" });
    expect(stackIds(app)).not.toContain("tenkacloud-challenge-payload");
    expect(dependencyEdges(app)).not.toContain(
      "tenkacloud-problem-deploy -> tenkacloud-challenge-payload",
    );
  });

  it("#2239: should add a participant-portal free-tier alarm only when the portal is enabled", () => {
    const alarmIds = (app: cdk.App): string[] => {
      const observability = app.node.children
        .filter(cdk.Stack.isStack)
        .find((stack) => stack.node.id === "tenkacloud-observability");
      const freeTier = observability?.node.tryFindChild("FreeTierAlarms");
      return freeTier ? freeTier.node.children.map((child) => child.node.id) : [];
    };
    // Issue #2961: FreeTierAlarms は budget と同じ opt-in の内側にあるので、この test の主題
    // (portal の有無で alarm が増えるか) を見るには先に budget を有効化する必要がある。
    // 展開は `loadConfig` が process.env を直読みするのでそちらに置く。
    const previous = process.env.MONTHLY_COST_LIMIT_USD;
    process.env.MONTHLY_COST_LIMIT_USD = "50";
    try {
      // Default (portal disabled): the ternary's [] arm — no participant-portal alarm.
      expect(alarmIds(buildApp())).not.toContain("LambdaInvocationsparticipantportal");
      // Portal enabled: the label-bearing arm produces the deterministic construct ID.
      expect(alarmIds(buildApp({ CDK_PARAM_ENABLE_PARTICIPANT_PORTAL: "true" }))).toContain(
        "LambdaInvocationsparticipantportal",
      );
    } finally {
      if (previous === undefined) delete process.env.MONTHLY_COST_LIMIT_USD;
      else process.env.MONTHLY_COST_LIMIT_USD = previous;
    }
  });
});
