import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveAppConfig } from "../../lib/app-config/resolve";
import { buildTenkaCloudApp } from "../../lib/app-wiring/wire";

/**
 * Issue #2959 x #2960: `CDK_PARAM_RETAIN_DATA_TABLES=true` が **組み上げた app にまで届く**
 * ことを見る。
 *
 * 単体では両方すでに test がある — table construct は removalPolicy を受け取り、Aspect は
 * 除外 type を尊重する。しかしその 2 つが繋がっていることは、どちらの test も見ていない。
 * wire.ts が config を読み損ねていても、あるいは Aspect に除外 type を渡し忘れていても、
 * 単体 test は両方緑のままになる。そして壊れ方は「残すと言ったデータが消える」で、
 * 気付くのは destroy した後になる。
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

/**
 * `retainDataTables` が支配するのは **TenkaCloud の control-data table 8 本**であって、
 * app 内の全 DynamoDB table ではない。SBT が control plane の内部に作る TenantDetails /
 * TenantRegistration は SBT 自身が削除方針を決めており、type 単位の除外はその意思を
 * そのまま残す (= 触らない)。ここを「全 table が Retain」と書くと、他人の table の方針まで
 * own しているかのような誤った契約を固定してしまう。
 */
const CONTROL_DATA_TABLE_PREFIXES = [
  "DeploymentsTable",
  "EventsTable",
  "TeamsTable",
  "ProblemEndpointsTable",
  "CompetitorAccountsTable",
  "DisruptionsTable",
  "AdminAuditLogTable",
  "SamlIdpsTable",
] as const;

function isControlDataTable(logicalId: string): boolean {
  return CONTROL_DATA_TABLE_PREFIXES.some((prefix) => logicalId.startsWith(prefix));
}

/** 組み上げた app 全体から、control-data table の DeletionPolicy を集める。 */
function tablePolicies(retainDataTables: boolean): string[] {
  const config = resolveAppConfig({
    env: {
      CDK_PARAM_SYSTEM_ADMIN_EMAIL: "admin@example.com",
      CDK_PARAM_S3_BUCKET_NAME: "test-bucket",
      CDK_SOURCE_NAME: "source.zip",
      CDK_PARAM_COMMIT_ID: "abcdef",
      CDK_PARAM_AWS_REGION: "ap-northeast-1",
      CDK_PARAM_AWS_ACCOUNT_ID: "123456789012",
      ...(retainDataTables ? { CDK_PARAM_RETAIN_DATA_TABLES: "true" } : {}),
    },
    binDir: BIN_DIR,
    fs: { existsSync: () => false },
    dotenvConfig: () => undefined,
    discoverProblems: stubProblems,
  });
  const app = new cdk.App({ autoSynth: false, context: { "aws:cdk:bundling-stacks": [] } });
  buildTenkaCloudApp(app, config);

  const policies: string[] = [];
  for (const stack of app.node.children.filter(cdk.Stack.isStack)) {
    const resources = Template.fromStack(stack).findResources("AWS::DynamoDB::Table");
    for (const [logicalId, resource] of Object.entries(resources)) {
      if (!isControlDataTable(logicalId)) continue;
      policies.push((resource as { DeletionPolicy?: string }).DeletionPolicy ?? "(absent)");
    }
  }
  return policies;
}

describe("#2959 x #2960: the retain opt-in survives the whole wiring", () => {
  beforeAll(() => {
    ensurePlaceholderDist("admin-console");
    ensurePlaceholderDist("application-admin-console");
    ensurePlaceholderDist("participant-portal");
  });

  it(
    "should destroy every table by default",
    () => {
      const policies = tablePolicies(false);
      // 8 本すべてを見ていることを数で担保する (= prefix が古くなって 0 件になったら落ちる)。
      expect(policies).toHaveLength(CONTROL_DATA_TABLE_PREFIXES.length);
      expect([...new Set(policies)]).toEqual(["Delete"]);
    },
    APP_BUILD_TIMEOUT_MS,
  );

  it(
    "should retain every table when the operator opted in, Aspect notwithstanding",
    () => {
      // DestroyPolicySetter は 10 stack すべてに当たっており、全 CfnResource を後勝ちで
      // 上書きする。ここが "Delete" になる実装は、明示的に残すと言われたデータを黙って消す。
      const policies = tablePolicies(true);
      expect(policies).toHaveLength(CONTROL_DATA_TABLE_PREFIXES.length);
      expect([...new Set(policies)]).toEqual(["Retain"]);
    },
    APP_BUILD_TIMEOUT_MS,
  );
});
