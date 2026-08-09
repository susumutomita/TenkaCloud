import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveAppConfig } from "../../lib/app-config/resolve";
import { buildTenkaCloudApp } from "../../lib/app-wiring/wire";

/**
 * Issue #2960: destroy 後に log group が 48 個残り、うち **29 個が retention 未設定
 * (= Never expire)** だった。残骸が残るだけでなく、残った分の保存料金が永久に出る形になっていた。
 *
 * `LogGroupRetention` Aspect はまさにこのために書かれており、CFn resource として存在する
 * log group には正しく効いている。ここではその範囲を機械で固定する — 組み立てた全 stack の
 * `AWS::Logs::LogGroup` は 1 つ残らず `RetentionInDays` を持たなければならない。
 *
 * app はこの test の中で組み立てる。`cdk.out` を読む形にすると `make check-synth` を先に
 * 走らせた環境でしか意味を持たず、coverage job のように synth を経ない経路では「0 件見つかった
 * ので違反なし」と読めてしまう。
 *
 * ## この test が守れない範囲 (意図的に明記する)
 *
 * 実測で retention=null だったのは、いずれも **synth に現れない** log group だった。
 * `/aws/lambda/*` は Lambda 関数の初回実行時に Lambda サービスが暗黙に作るので、CFn resource
 * ではなく Aspect の視界にも synth 出力にも入らない。具体的には CDK 自身が生成する custom
 * resource provider (`CustomCDKBucketDeployment` / `CustomS3AutoDeleteObjects` /
 * `CustomAWSCDKOpenIdConnectProvider`) と `/aws/codebuild/*` がそれにあたる。
 *
 * したがって「synth 上は全件 retention 付き」であることと「アカウント上に無期限保持が無い」
 * ことは **同じではない**。後者は cleanup.sh の log group sweep が回収する。この test を
 * 「全部塞いだ証明」として読まないこと。
 */

const BIN_DIR = path.resolve(__dirname, "..", "..", "bin");
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const APP_BUILD_TIMEOUT_MS = 30_000;

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

interface LogGroupRow {
  readonly stack: string;
  readonly logicalId: string;
  readonly retention: unknown;
}

interface FunctionRow {
  readonly stack: string;
  readonly logicalId: string;
  readonly hasExplicitLogGroup: boolean;
}

/**
 * Lambda で **明示 LogGroup を持てないと分かっている**もの (#2960)。
 *
 * ここに載っているものは、 log group が実行時に Lambda サービスによって暗黙生成され、
 * retention 未設定 (= 無期限保持) で生まれる。 `scripts/enforce-log-retention.sh` の backstop が
 * deploy 後に拾う対象そのものである。
 *
 * 一覧として固定するのは、 **新しく増えたときに気付くため**。 「塞げないものがある」で終わりに
 * すると、 次に足された Lambda がそこに紛れて、 誰も気付かないまま無期限保持が 1 つ増える。
 * 理由なしにこの表へ足さないこと — 構築側で `logGroup` を渡せるなら渡すのが先。
 */
const NO_EXPLICIT_LOG_GROUP: readonly { readonly match: RegExp; readonly reason: string }[] = [
  {
    match: /CustomS3AutoDeleteObjectsCustomResourceProviderHandler/,
    reason:
      "`Bucket({ autoDeleteObjects: true })` が construct 内部で singleton として作る provider。 " +
      "aws-cdk-lib 2.262.1 の型定義に log 設定の prop が無い。",
  },
  {
    match: /CustomAWSCDKOpenIdConnectProviderCustomResourceProviderHandler/,
    reason:
      "`iam.OpenIdConnectProvider` が内部で作る `Custom::AWSCDKOpenIdConnectProvider` の provider。 " +
      "`OpenIdConnectProviderProps` に log 設定の prop が無い。",
  },
  {
    match: /^(CognitoAuth|ControlPlanetenant)/,
    reason:
      "SBT (`@cdklabs/sbt-aws`) が control plane 内に作る Lambda。 third-party construct で、 " +
      "log group を外から差し込む API が無い。",
  },
  {
    match: /^AWS679f53fac002430cb0da5b/,
    reason:
      "SBT が control plane 内に作る `AwsCustomResource` の provider。 こちらの構築コードから " +
      "props を渡す経路が無い。 自前の `AwsCustomResource` (tenant-template の " +
      "`CreateTenantMapping`) には `logGroup` を渡してあるので、 ここに残るのは SBT 側だけ。",
  },
];

function allLogGroups(): LogGroupRow[] {
  const config = resolveAppConfig({
    env: {
      CDK_PARAM_SYSTEM_ADMIN_EMAIL: "admin@example.com",
      CDK_PARAM_S3_BUCKET_NAME: "test-bucket",
      CDK_SOURCE_NAME: "source.zip",
      CDK_PARAM_COMMIT_ID: "abcdef",
      CDK_PARAM_AWS_REGION: "ap-northeast-1",
      CDK_PARAM_AWS_ACCOUNT_ID: "123456789012",
    },
    binDir: BIN_DIR,
    fs: { existsSync: () => false },
    dotenvConfig: () => undefined,
    discoverProblems: stubProblems,
  });
  const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
  buildTenkaCloudApp(app, config);

  const rows: LogGroupRow[] = [];
  for (const stack of app.node.children.filter(cdk.Stack.isStack)) {
    const resources = Template.fromStack(stack).findResources("AWS::Logs::LogGroup");
    for (const [logicalId, resource] of Object.entries(resources)) {
      rows.push({
        stack: stack.node.id,
        logicalId,
        retention: (resource as { Properties?: Record<string, unknown> }).Properties
          ?.RetentionInDays,
      });
    }
  }
  return rows;
}

function allFunctions(): FunctionRow[] {
  const config = resolveAppConfig({
    env: {
      CDK_PARAM_SYSTEM_ADMIN_EMAIL: "admin@example.com",
      CDK_PARAM_S3_BUCKET_NAME: "test-bucket",
      CDK_SOURCE_NAME: "source.zip",
      CDK_PARAM_COMMIT_ID: "abcdef",
      CDK_PARAM_AWS_REGION: "ap-northeast-1",
      CDK_PARAM_AWS_ACCOUNT_ID: "123456789012",
    },
    binDir: BIN_DIR,
    fs: { existsSync: () => false },
    dotenvConfig: () => undefined,
    discoverProblems: stubProblems,
  });
  const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
  buildTenkaCloudApp(app, config);

  const rows: FunctionRow[] = [];
  for (const stack of app.node.children.filter(cdk.Stack.isStack)) {
    const resources = Template.fromStack(stack).findResources("AWS::Lambda::Function");
    for (const [logicalId, resource] of Object.entries(resources)) {
      const properties = (resource as { Properties?: Record<string, unknown> }).Properties ?? {};
      const logging = properties.LoggingConfig as { LogGroup?: unknown } | undefined;
      rows.push({
        stack: stack.node.id,
        logicalId,
        hasExplicitLogGroup: logging?.LogGroup !== undefined,
      });
    }
  }
  return rows;
}

describe("#2960: every Lambda either has an explicit log group or a recorded reason", () => {
  let functions: FunctionRow[];

  beforeAll(() => {
    ensurePlaceholderDist("admin-console");
    ensurePlaceholderDist("application-admin-console");
    ensurePlaceholderDist("participant-portal");
    functions = allFunctions();
  }, APP_BUILD_TIMEOUT_MS);

  it("should actually find Lambdas to inspect", () => {
    expect(functions.length).toBeGreaterThan(0);
  });

  it("should not add a Lambda whose log group nothing configures", () => {
    // 明示 LogGroup を持たない Lambda の log group は初回実行時に Lambda サービスが作り、
    // retention 未設定 = 無期限保持で生まれる。 塞げないものは表に理由付きで載せてあるので、
    // ここに出てくるのは 「渡せるのに渡していない」 か 「新しく増えた」 かのどちらか。
    const unexplained = functions
      .filter((row) => !row.hasExplicitLogGroup)
      .filter((row) => !NO_EXPLICIT_LOG_GROUP.some((entry) => entry.match.test(row.logicalId)))
      .map((row) => `${row.stack}:${row.logicalId}`);
    expect(
      unexplained,
      `明示 LogGroup を持たない Lambda: ${unexplained.join(", ")}。` +
        "構築側で `logGroup` を渡せるなら渡し、 渡せないなら NO_EXPLICIT_LOG_GROUP へ理由付きで足す",
    ).toEqual([]);
  });

  it("should keep every recorded exception real", () => {
    // 塞げたのに表に残ったままだと、 一覧が実態と食い違って読み手を誤らせる。
    const stale = NO_EXPLICIT_LOG_GROUP.filter(
      (entry) =>
        !functions.some((row) => !row.hasExplicitLogGroup && entry.match.test(row.logicalId)),
    ).map((entry) => String(entry.match));
    expect(stale, `もう存在しない例外が残っています: ${stale.join(", ")}`).toEqual([]);
  });

  it("should give every BucketDeployment an explicit log group", () => {
    // これがこの Issue で構築側から実際に塞げた分。
    const bucketDeployments = functions.filter((row) =>
      /CustomCDKBucketDeployment/.test(row.logicalId),
    );
    expect(bucketDeployments.length).toBeGreaterThan(0);
    expect(bucketDeployments.filter((row) => !row.hasExplicitLogGroup)).toEqual([]);
  });
});

describe("#2960: every synthesized log group carries a retention", () => {
  let rows: LogGroupRow[];

  beforeAll(() => {
    ensurePlaceholderDist("admin-console");
    ensurePlaceholderDist("application-admin-console");
    ensurePlaceholderDist("participant-portal");
    rows = allLogGroups();
  }, APP_BUILD_TIMEOUT_MS);

  it("should actually find log groups to inspect", () => {
    // 0 件を「違反なし」と読むと、この test は走査が壊れた瞬間から永遠に緑になる。
    expect(rows.length, "log group が 1 つも見つからないのは走査が壊れている兆候").toBeGreaterThan(
      0,
    );
  });

  it("should never emit a log group without RetentionInDays", () => {
    const offenders = rows
      .filter((row) => row.retention === undefined)
      .map((row) => `${row.stack}:${row.logicalId}`);
    expect(offenders, `retention 未設定の log group: ${offenders.join(", ")}`).toEqual([]);
  });
});
