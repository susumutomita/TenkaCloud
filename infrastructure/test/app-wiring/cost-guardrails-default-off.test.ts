import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveAppConfig } from "../../lib/app-config/resolve";
import { buildTenkaCloudApp } from "../../lib/app-wiring/wire";

/**
 * Issue #2961: コスト監視を既定 OFF にし、購読確認メールが deploy のたびに届くのをやめる。
 *
 * ここで固定したいのは 2 つで、どちらも「メールが届かないこと」ではなく **resource を作らない
 * こと**として書く。未確認の SNS 購読は `SubscriptionArn` が実 ARN ではなく
 * `PendingConfirmation` なので、`aws sns unsubscribe` に渡す ARN が存在せず **API でも手でも
 * 消せない**。作ってしまってから消す経路が無いので、作らない側で pin するしかない。
 *
 *  1. 何も設定しなければ Budget / Topic / Subscription が 1 件も出ない
 *  2. budget を opt-in しても、宛先を明示しない限り Subscription は出ない
 */

const BIN_DIR = path.resolve(__dirname, "..", "..", "bin");
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

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

/**
 * `.env` の読み込みだけ潰し、`environments/<env>/config.json` は**実ファイルを読ませる**。
 * この test の主題が config.json の既定値そのものなので、ここを stub すると何も検証できない。
 */
function observabilityTemplate(envOverrides: Record<string, string> = {}): Template {
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
  const app = new cdk.App({ autoSynth: false, context: { "aws:cdk:bundling-stacks": [] } });
  buildTenkaCloudApp(app, config);
  // development 以外では stack ID に環境名 suffix が付く (#992) ので prefix で引く。
  const observability = app.node.children
    .filter(cdk.Stack.isStack)
    .find((stack) => stack.node.id.startsWith("tenkacloud-observability"));
  if (!observability) throw new Error("observability stack not found");
  return Template.fromStack(observability);
}

/**
 * 1 件あたり 10 stack 分の app を組み立てるため、vitest 既定の 5000ms では cold run が入らない
 * (実測 約 5.0s)。既定値そのものを測る test なので app 構築は省けない。既定 (= 追加設定なし) の
 * template は全 test で共有し、構築回数を減らしたうえで残りに明示予算を与える。
 */
const APP_BUILD_TIMEOUT_MS = 30_000;

describe("#2961: cost guardrails are opt-in", () => {
  let defaultTemplate: Template;

  beforeAll(() => {
    ensurePlaceholderDist("admin-console");
    ensurePlaceholderDist("application-admin-console");
    ensurePlaceholderDist("participant-portal");
    defaultTemplate = observabilityTemplate();
  }, APP_BUILD_TIMEOUT_MS);

  it("should create no budget, topic or subscription when nothing is configured", () => {
    defaultTemplate.resourceCountIs("AWS::Budgets::Budget", 0);
    defaultTemplate.resourceCountIs("AWS::SNS::Topic", 0);
    defaultTemplate.resourceCountIs("AWS::SNS::Subscription", 0);
  });

  it(
    "should create no budget in production either, since the default is not environment-scoped",
    () => {
      // 環境名で分岐すると「本番だけメールが来続ける」という別の消し忘れになる。既定は一律 OFF。
      const template = observabilityTemplate({
        CDK_PARAM_ENVIRONMENT: "production",
        CDK_PARAM_API_KEY_PLATINUM_TIER_PARAMETER: "test-platinum",
        CDK_PARAM_API_KEY_PREMIUM_TIER_PARAMETER: "test-premium",
        CDK_PARAM_API_KEY_STANDARD_TIER_PARAMETER: "test-standard",
        CDK_PARAM_API_KEY_BASIC_TIER_PARAMETER: "test-basic",
      });
      template.resourceCountIs("AWS::Budgets::Budget", 0);
      template.resourceCountIs("AWS::SNS::Subscription", 0);
    },
    APP_BUILD_TIMEOUT_MS,
  );

  it(
    "should create the budget and topic but never subscribe systemAdminEmail",
    () => {
      // ここが本題。`CDK_PARAM_SYSTEM_ADMIN_EMAIL` は上の harness で必ず設定されており、
      // development の config.json は `budgetAlarmEmails` を持たない。つまりこの構成で
      // Subscription が 1 件でも出るなら、それは systemAdminEmail を購読先に流用している。
      // 「システム管理者の連絡先」と「予算アラートを受け取りたい人」を同一視していたのが
      // deploy のたびに確認メールが届いていた原因なので、0 件であることを直接見る。
      // config.json の `${MONTHLY_COST_LIMIT_USD:-0}` 展開は `loadConfig` が `process.env` を
      // 直接読むので、注入した env ではなくこちらに置く。
      const previous = process.env.MONTHLY_COST_LIMIT_USD;
      process.env.MONTHLY_COST_LIMIT_USD = "50";
      let template: Template;
      try {
        template = observabilityTemplate();
      } finally {
        if (previous === undefined) delete process.env.MONTHLY_COST_LIMIT_USD;
        else process.env.MONTHLY_COST_LIMIT_USD = previous;
      }
      template.resourceCountIs("AWS::Budgets::Budget", 1);
      template.resourceCountIs("AWS::SNS::Topic", 1);
      template.resourceCountIs("AWS::SNS::Subscription", 0);

      const subscriptions = template.findResources("AWS::SNS::Subscription");
      const endpoints = Object.values(subscriptions).map((row) => row.Properties?.Endpoint);
      expect(endpoints).not.toContain("admin@example.com");
    },
    APP_BUILD_TIMEOUT_MS,
  );

  it("should keep FreeTierAlarms tied to the budget so synth does not break when it is off", () => {
    // FreeTierAlarms は budget.topic を参照するので、budget を作らない構成では
    // 自身も作られないことを確認する (参照だけ残ると synth が壊れる)。
    defaultTemplate.resourceCountIs("AWS::CloudWatch::Alarm", 0);
  });
});
