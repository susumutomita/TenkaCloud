import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { synthDefault } from "./problem-deploy-backend-stack.test-helpers";

describe("ProblemDeployBackendStack (MVP-1) — Deploy API Lambda (invoked from tenant API)", () => {
  const tpl = synthDefault();

  it("should run on Node.js 22 / arm64 without the BATTLE_PROBLEMS_CATALOG env (#1308 bundled-define)", () => {
    // Issue #1308: BATTLE_PROBLEMS_CATALOG は #1158 と同じ esbuild bundling.define で build 時
    // literal 置換し、 Lambda env から取り除いた (= 4 KB env 上限を回避)。 handler は
    // `process.env.BATTLE_PROBLEMS_CATALOG` 読み取りのまま動く (= build 後に literal JSON が固定)。
    const functions = tpl.findResources("AWS::Lambda::Function");
    const deployApi = Object.entries(functions).find(
      ([name]) => name.includes("DeployApi") && name.includes("Function"),
    );
    expect(deployApi).toBeDefined();
    const props = deployApi?.[1] as {
      Properties?: {
        Runtime?: string;
        Architectures?: readonly string[];
        Environment?: { Variables?: Record<string, unknown> };
      };
    };
    expect(props.Properties?.Runtime).toBe("nodejs22.x");
    expect(props.Properties?.Architectures).toEqual(["arm64"]);
    const vars = props.Properties?.Environment?.Variables ?? {};
    expect(vars.BATTLE_PROBLEMS_CATALOG).toBeUndefined();
  });

  it("EventApi Lambda env should not include BATTLE_PROBLEMS_CATALOG / BATTLE_PROBLEMS_DISRUPTIONS (#1308)", () => {
    // Issue #1308 root cause: BATTLE_PROBLEMS_DISRUPTIONS (~2.5KB+) + BATTLE_PROBLEMS_CATALOG +
    // 8 個の他 env で 4 KB Lambda env hard limit を超過し EventApi が CREATE_FAILED。
    // bundling.define 経由に切替えて env から落とす。
    const functions = tpl.findResources("AWS::Lambda::Function");
    const eventApi = Object.entries(functions).find(
      ([name]) => name.includes("EventApi") && name.includes("Function"),
    );
    expect(eventApi).toBeDefined();
    const vars =
      (
        eventApi?.[1] as {
          Properties?: { Environment?: { Variables?: Record<string, unknown> } };
        }
      )?.Properties?.Environment?.Variables ?? {};
    // pin: env から消えていること
    expect(vars.BATTLE_PROBLEMS_CATALOG).toBeUndefined();
    expect(vars.BATTLE_PROBLEMS_DISRUPTIONS).toBeUndefined();
    // pin: 残しておく env が消えていないこと (= regression 防止)
    expect(vars.EVENTS_TABLE_NAME).toBeDefined();
    expect(vars.DISRUPTIONS_TABLE_NAME).toBeDefined();
  });

  it("EventApi Lambda total env size should stay under 3 KB (1 KB margin under the 4 KB hard limit, #1308)", () => {
    // 4 KB hard limit に張り付くと問題追加で deploy が壊れるため、 3 KB に閾値を引き下げる
    // (= 1 KB 余裕を保つ)。 4 KB は Lambda の AWS::Lambda::Function Environment.Variables の
    // serialized key=value 合計のため、 token 含む CFn intrinsic は概算長で OK (= 値が小さい)。
    const functions = tpl.findResources("AWS::Lambda::Function");
    const eventApi = Object.entries(functions).find(
      ([name]) => name.includes("EventApi") && name.includes("Function"),
    );
    expect(eventApi).toBeDefined();
    const vars =
      (
        eventApi?.[1] as {
          Properties?: { Environment?: { Variables?: Record<string, unknown> } };
        }
      )?.Properties?.Environment?.Variables ?? {};
    const serialized = JSON.stringify(vars);
    expect(serialized.length).toBeLessThan(3 * 1024);
  });

  // #534: CFn StackEvents / StackResources を読む IAM Allow を持つべき
  // (= deploy job 詳細ページから直接 CFn API を叩くため)。
  it("should Allow CFn DescribeStackEvents / DescribeStackResources", () => {
    tpl.hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Action: Match.arrayWith([
                "cloudformation:DescribeStackEvents",
                "cloudformation:DescribeStackResources",
              ]),
            }),
          ]),
        }),
      }),
    );
  });
});

describe("ProblemDeployBackendStack (MVP-1) — GenericScoring Lambda", () => {
  const tpl = synthDefault();

  it("GenericScoring Lambda should have table-name env without the catalog env", () => {
    // Issue #1158: BATTLE_PROBLEMS_SCORING / PROBLEM_ENDPOINTS / BATTLE_PROBLEMS_PHASES は
    // env vars 4 KB 上限を回避するため esbuild bundling.define で build 時 literal 置換し、
    // Lambda env からは取り除いている。 catalog 配線は handler の `process.env.X` 読み取りが
    // build 時に literal JSON に固定され、 runtime IO 0 で動く。
    const functions = tpl.findResources("AWS::Lambda::Function");
    const genericScoring = Object.entries(functions).find(
      ([name]) => name.includes("GenericScoring") && name.includes("Function"),
    );
    expect(genericScoring).toBeDefined();
    const vars =
      (
        genericScoring?.[1] as {
          Properties?: { Environment?: { Variables?: Record<string, unknown> } };
        }
      )?.Properties?.Environment?.Variables ?? {};
    expect(vars.DEPLOYMENTS_TABLE_NAME).toBeDefined();
    expect(vars.EVENTS_TABLE_NAME).toBeDefined();
    expect(vars.PROBLEM_ENDPOINTS_TABLE_NAME).toBeDefined();
    expect(vars.BATTLE_PROBLEMS_SCORING).toBeUndefined();
    expect(vars.PROBLEM_ENDPOINTS).toBeUndefined();
    expect(vars.BATTLE_PROBLEMS_PHASES).toBeUndefined();
  });
});

describe("ProblemDeployBackendStack (MVP-1) — SystemAuditWriter Lambda (Issue #1034)", () => {
  const tpl = synthDefault();

  it("SystemAuditWriter Lambda should have DEPLOY_ENVIRONMENT + ADMIN_AUDIT_LOG_TABLE_NAME env", () => {
    // env が無いと writeAuditEvent が no-op になり、 audit が書かれない silent failure に戻る。
    tpl.hasResourceProperties(
      "AWS::Lambda::Function",
      Match.objectLike({
        Runtime: "nodejs22.x",
        Architectures: ["arm64"],
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            ADMIN_AUDIT_LOG_TABLE_NAME: Match.anyValue(),
            DEPLOY_ENVIRONMENT: "development",
          }),
        }),
      }),
    );
  });
});

describe("ProblemDeployBackendStack — EventApi Lambda audit log read grant (#1313)", () => {
  const tpl = synthDefault();

  it("EventApi Role default policy should include both DDB read + write actions (= grantReadWriteData)", () => {
    // Issue #1313: PR #1297 で event-handler 内に registerAuditLogRoutes (GET /admin/audit-log + /export) が
    // wire 済だが、 EventApiLambda の IAM grant は `grantWriteData` だけだったため、 read 経路が
    // AccessDenied で 5xx を返し UI は "Failed to fetch" を表示していた。
    //
    // `grantReadWriteData` に上げると read + write 両方の DynamoDB actions が EventApi role に
    // 付与される (= AccessDenied 解消)。 EventApi Role の DefaultPolicy 内に read + write 双方の
    // 代表 action が同居していることを直接 inspect で確認する (= grantReadWriteData の証跡)。
    const policies = tpl.findResources("AWS::IAM::Policy");
    const eventApiPolicy = Object.entries(policies).find(
      ([logicalId]) =>
        logicalId.includes("EventApi") &&
        logicalId.includes("ServiceRole") &&
        logicalId.includes("DefaultPolicy"),
    );
    expect(eventApiPolicy).toBeDefined();
    const stmt = (
      eventApiPolicy?.[1] as {
        Properties?: { PolicyDocument?: { Statement?: ReadonlyArray<Record<string, unknown>> } };
      }
    )?.Properties?.PolicyDocument?.Statement;
    expect(Array.isArray(stmt)).toBe(true);
    // Action は string | string[] のどちらでも来る。 一連の actions を flat 化して set で見る。
    const allActions = new Set<string>();
    for (const s of stmt ?? []) {
      const action = s.Action as string | string[] | undefined;
      if (typeof action === "string") allActions.add(action);
      else if (Array.isArray(action)) for (const a of action) allActions.add(a);
    }
    // grantReadWriteData の代表的 actions (= read+write 両方が混在する)
    expect(allActions.has("dynamodb:Query")).toBe(true);
    expect(allActions.has("dynamodb:GetItem")).toBe(true);
    expect(allActions.has("dynamodb:PutItem")).toBe(true);
    expect(allActions.has("dynamodb:UpdateItem")).toBe(true);
  });
});

describe("ProblemDeployBackendStack (MVP-1) — Competitor Accounts API Lambda (Issue #459 / ADR-002 Phase 2.1)", () => {
  const tpl = synthDefault();

  it("Lambda should have COMPETITOR_ACCOUNTS_TABLE_NAME / DEPLOY_ENVIRONMENT / TENKACLOUD_ACCOUNT_ID env", () => {
    tpl.hasResourceProperties(
      "AWS::Lambda::Function",
      Match.objectLike({
        Runtime: "nodejs22.x",
        Architectures: ["arm64"],
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            COMPETITOR_ACCOUNTS_TABLE_NAME: Match.anyValue(),
            DEPLOY_ENVIRONMENT: "development",
            TENKACLOUD_ACCOUNT_ID: Match.anyValue(),
          }),
        }),
      }),
    );
  });

  it("should grant least-privilege SSM Parameter Store + STS AssumeRole to the Lambda Role", () => {
    // SSM は path prefix で絞り込み、STS は TenkaCloud- Role 名 pattern で絞り込み。
    tpl.hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Action: Match.arrayWith(["ssm:GetParameter", "ssm:PutParameter"]),
            }),
          ]),
        }),
      }),
    );
    tpl.hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Action: "sts:AssumeRole",
              Resource: "arn:aws:iam::*:role/TenkaCloud-*",
            }),
          ]),
        }),
      }),
    );
  });

  it("Phase 3.2 / Issue #603: ExternalIdAudit Lambda should run on rate(1 day) and have PutMetricData (namespace-scoped)", () => {
    // rate(1 day) schedule は Events rules test でも assert 済だが、ここでは
    // ExternalIdAudit 経路の代表 evidence (COMPETITOR_ACCOUNTS_TABLE_NAME env + namespace 絞り込み IAM) を pin する。
    tpl.hasResourceProperties(
      "AWS::Lambda::Function",
      Match.objectLike({
        Runtime: "nodejs22.x",
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            COMPETITOR_ACCOUNTS_TABLE_NAME: Match.anyValue(),
            DEPLOY_ENVIRONMENT: "development",
          }),
        }),
      }),
    );
    tpl.hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Action: "cloudwatch:PutMetricData",
              Resource: "*",
              Condition: Match.objectLike({
                StringEquals: Match.objectLike({
                  "cloudwatch:namespace": "TenkaCloud/CompetitorAccounts",
                }),
              }),
            }),
          ]),
        }),
      }),
    );
  });

  it("KMS policy should have StringLike + Decrypt/GenerateDataKey (supports both SSM SecureString GET/PUT)", () => {
    // **regression 防止**: 旧実装は StringEquals + Decrypt/Encrypt の組合せだった (PR-594
    // /security-review Vuln 1)。`StringEquals` は wildcard 展開しないので Condition が
    // 永久に false で fail-closed、Encrypt は SecureString PUT に不適合 (GenerateDataKey 必要)。
    // この test で StringLike + Decrypt + GenerateDataKey の組合せを pin する。
    tpl.hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Action: Match.arrayWith(["kms:Decrypt", "kms:GenerateDataKey"]),
              Resource: "*",
              Condition: Match.objectLike({
                StringLike: Match.objectLike({
                  "kms:EncryptionContext:PARAMETER_ARN": Match.anyValue(),
                }),
              }),
            }),
          ]),
        }),
      }),
    );
  });
});
