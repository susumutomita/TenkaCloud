#!/usr/bin/env node
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import { CodeBuildUseAwsManagedKms } from "../lib/cdk-aspect/codebuild-use-aws-managed-kms.js";
import { DynamoDbLowCapacity } from "../lib/cdk-aspect/dynamodb-low-capacity.js";
import { KmsKeyShortPendingWindow } from "../lib/cdk-aspect/kms-key-short-pending-window.js";
import { LogGroupRetention } from "../lib/cdk-aspect/log-group-retention.js";
import { IntentIngressStack } from "../lib/intent-ingress/intent-ingress-stack.js";
import { discoverProblemsCatalog } from "../lib/utils/discover-problems-catalog.js";

/**
 * ADR-049 Phase 4 (Issue #2293) SLICE 2 — Always-On mode の signed-intent ingress を
 * **手動で `cdk deploy` する経路** の composition root。
 *
 * ADR-049 §8 が Phase 4 タスクとして "runtime スタックの手動デプロイ経路 (make target) を維持" を
 * 明示している。SLICE 1 で追加された {@link IntentIngressStack} は deploy 可能だがどの `bin/*.ts` にも
 * 未配線 (= ingress cutover は別オペレーション) だった。本ファイルはその stack を **ただ 1 つだけ**
 * `new cdk.App()` 上に立て、operator が `make deploy-always-on-ingress` で live-test できるようにする。
 *
 * 配線の原則:
 *   - Always-On mode (ADR-049) は SBT / ControlPlane / tenant pipeline を **一切** 持ち込まない。
 *     したがって本 app は SaaS/Lite の `resolveAppConfig` (= SYSTEM_ADMIN_EMAIL / source bundle 等を
 *     必須にする) を経由せず、intent-ingress 固有の env だけを読む (= モードの独立性を保つ)。
 *   - App scope の Tags / Aspects は `lib/app-wiring/wire/aspects.ts` の `applyGlobalAspects` /
 *     `applyDynamoLowCapacity` と **同じ集合** を replicate する (KMS pending window / CodeBuild KMS /
 *     LogGroup retention / DynamoDB 1-1 PROVISIONED)。KMS / CodeBuild aspect は本 stack には対象資源が
 *     無いため実質 no-op だが、集合を揃えることで将来 stack が KMS 等を持ったときの drift を防ぐ。
 *   - `bin/infrastructure.ts` / `bin/tenkacloud-lite.ts` / `bin/tenkacloud-pack.ts` には触れないため、
 *     既存 deploy 経路 (`make deploy` / `deploy-saas` / `deploy-battles`) は完全に NO-OP。
 */

/** 立てる唯一の stack の logical id。 `make deploy/destroy-always-on-ingress` の対象名と一致させる。 */
export const INTENT_INGRESS_STACK_ID = "tenkacloud-intent-ingress";

/** verify secret parameter 名を保持する必須 env の名前 (fail-loud の対象)。 */
export const VERIFY_SECRET_PARAM_ENV = "CDK_PARAM_INTENT_INGRESS_VERIFY_SECRET_PARAM";

export interface BuildIntentIngressAppOptions {
  /** 解決に使う環境変数 (production は `process.env`、test は fake env)。 */
  readonly env: NodeJS.ProcessEnv;
  /** `import.meta.dirname` (= `infrastructure/bin`)。`problems/` tree の base path 解決に使う。 */
  readonly binDir: string;
  /**
   * problemsCatalog の取得元を差し替える test hook。既定は {@link discoverProblemsCatalog}
   * (= SaaS/Lite の `LocalCatalogSource.loadBundle().catalog` と同じ source-of-truth)。
   */
  readonly discoverCatalog?: (problemsRoot: string) => Readonly<Record<string, string>>;
}

/**
 * {@link IntentIngressStack} を 1 つだけ抱える `cdk.App` を構築して返す (副作用は App 生成のみ)。
 *
 * `bin/*.ts` から切り出した testable な composition function。thin shim (末尾の entrypoint guard) は
 * `process.env` を渡してこれを呼ぶだけなので、synth の shape はすべてここで pin できる。
 */
export function buildIntentIngressApp(options: BuildIntentIngressAppOptions): cdk.App {
  const { env } = options;
  const app = new cdk.App();

  // `make check-synth` 系の高速 shape チェック用: Lambda の実バンドルを skip する
  // (bin/infrastructure.ts と同じ passthrough)。CLI の `-c` は `aws:` prefix を拒否するため code 側で。
  if (env.CDK_SKIP_BUNDLING === "1") {
    app.node.setContext("aws:cdk:bundling-stacks", []);
  }

  const environment = env.CDK_PARAM_ENVIRONMENT ?? "development";

  // App scope Tags / Aspects — lib/app-wiring/wire/aspects.ts の applyGlobalAspects と同じ集合。
  cdk.Tags.of(app).add("Project", "TenkaCloud");
  cdk.Tags.of(app).add("Environment", environment);
  cdk.Aspects.of(app).add(
    new KmsKeyShortPendingWindow(Number(env.CDK_PARAM_KMS_PENDING_WINDOW_DAYS || 7)),
  );
  cdk.Aspects.of(app).add(new CodeBuildUseAwsManagedKms());
  cdk.Aspects.of(app).add(new LogGroupRetention());

  const verifySecretParameterName = requireEnv(env, VERIFY_SECRET_PARAM_ENV);
  const competitorAccountsTableName = requireEnv(env, "CDK_PARAM_COMPETITOR_ACCOUNTS_TABLE_NAME");
  const competitorAccountsTableArn = requireEnv(env, "CDK_PARAM_COMPETITOR_ACCOUNTS_TABLE_ARN");
  const problemsCatalog = (options.discoverCatalog ?? discoverProblemsCatalog)(
    // resolveAppConfig の discoverAppProblems と同じ problems/ root (= repo 直下)。
    path.resolve(options.binDir, "..", "..", "problems"),
  );

  const eventBusArn = nonEmpty(env.CDK_PARAM_EVENT_BUS_ARN);
  const expectedAudience = nonEmpty(env.CDK_PARAM_INTENT_INGRESS_EXPECTED_AUDIENCE);
  const allowedTenantIds = parseCsv(env.CDK_PARAM_INTENT_INGRESS_ALLOWED_TENANT_IDS);
  const allowedEventIds = parseCsv(env.CDK_PARAM_INTENT_INGRESS_ALLOWED_EVENT_IDS);

  const stack = new IntentIngressStack(app, INTENT_INGRESS_STACK_ID, {
    ...resolveStackEnv(env),
    verifySecretParameterName,
    problemsCatalog,
    competitorAccountsTableName,
    competitorAccountsTableArn,
    environmentName: environment,
    // 省略時は stack 側が local bus を作る (= standalone)。渡せば既存 deploy bus へ re-emit。
    ...(eventBusArn ? { eventBusArn } : {}),
    ...(expectedAudience ? { expectedAudience } : {}),
    ...(allowedTenantIds ? { allowedTenantIds } : {}),
    ...(allowedEventIds ? { allowedEventIds } : {}),
  });

  // Stack scope Aspect — applyDynamoLowCapacity と同じ (Free Tier 1/1 PROVISIONED)。
  cdk.Aspects.of(stack).add(
    new DynamoDbLowCapacity(
      Number(env.CDK_PARAM_DYNAMODB_READ_CAPACITY || 1),
      Number(env.CDK_PARAM_DYNAMODB_WRITE_CAPACITY || 1),
    ),
  );

  return app;
}

/** account / region が両方 set のときだけ env-aware にする stackProps fragment (resolveAwsEnvironment と同挙動)。 */
function resolveStackEnv(env: NodeJS.ProcessEnv): { env?: { account: string; region: string } } {
  const account = env.CDK_PARAM_AWS_ACCOUNT_ID ?? env.CDK_DEFAULT_ACCOUNT ?? "";
  const region = env.CDK_PARAM_AWS_REGION ?? env.CDK_DEFAULT_REGION ?? "";
  return account && region ? { env: { account, region } } : {};
}

/** 必須 env を読み、未設定 / 空文字なら fail-loud (silent default を作らない、repo 規約)。 */
function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required to deploy the always-on signed-intent ingress.`);
  }
  return value;
}

/** 空文字 / 未設定を undefined に畳む (optional prop の省略判定用)。 */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

/** comma 区切り env を trim + 空要素除去して string[] にする。空 / 未設定は undefined (allowlist 無効)。 */
function parseCsv(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

// thin entrypoint shim: `cdk deploy --app "bunx tsx bin/tenkacloud-always-on.ts"` で実行されたときだけ
// App を構築する。import.meta.main は Node 22 / tsx で undefined のため、argv[1] を絶対パス化して比較する
// (vitest から import されたときは argv[1] が runner なので発火しない = 副作用フリー)。
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  buildIntentIngressApp({ env: process.env, binDir: import.meta.dirname });
}
