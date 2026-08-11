import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { deployApiBundlingDefine } from "../lib/problem-deploy/deploy-api-lambda";
import { eventApiBundlingDefine } from "../lib/problem-deploy/event-api-lambda";
import {
  synthDefault,
  synthWithControlDataBackendTurso,
  synthWithDeployConcurrentBuildLimit,
} from "./problem-deploy-backend-stack.test-helpers";

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
    expect(vars.BATTLE_PROBLEMS_RUNTIMES).toBeUndefined();
  });

  it("DeployApi bundling define should include the runtime catalog", () => {
    const define = deployApiBundlingDefine({
      problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
      problemRuntimes: {
        "battle-non-aws": { provider: "sakura", engine: "apprun", entry: "template.yaml" },
      },
    });

    expect(JSON.parse(define["process.env.BATTLE_PROBLEMS_RUNTIMES"])).toBe(
      JSON.stringify({
        "battle-non-aws": { provider: "sakura", engine: "apprun", entry: "template.yaml" },
      }),
    );
  });

  it("DeployApi env DEPLOY_QUOTA_BY_TIER should default to empty (quota disabled, #1766)", () => {
    const functions = tpl.findResources("AWS::Lambda::Function");
    const deployApi = Object.entries(functions).find(
      ([name]) => name.includes("DeployApi") && name.includes("Function"),
    );
    const vars =
      (
        deployApi?.[1] as {
          Properties?: { Environment?: { Variables?: Record<string, unknown> } };
        }
      )?.Properties?.Environment?.Variables ?? {};
    expect(vars.DEPLOY_QUOTA_BY_TIER).toBe("");
  });

  it("DeployApi env DEPLOY_QUOTA_BY_TIER should carry the configured tier limits as JSON (#1766)", () => {
    const tplWithQuota = synthWithDeployConcurrentBuildLimit();
    const functions = tplWithQuota.findResources("AWS::Lambda::Function");
    const deployApi = Object.entries(functions).find(
      ([name]) => name.includes("DeployApi") && name.includes("Function"),
    );
    const vars =
      (
        deployApi?.[1] as {
          Properties?: { Environment?: { Variables?: Record<string, unknown> } };
        }
      )?.Properties?.Environment?.Variables ?? {};
    expect(JSON.parse(String(vars.DEPLOY_QUOTA_BY_TIER))).toEqual({
      basic: 2,
      advanced: 5,
      platinum: 10,
    });
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

  it("EventApi Lambda bundling define should include the runtime provenance map (#2464)", () => {
    const define = eventApiBundlingDefine({
      problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
      problemsDisruptions: {},
      problemsProvenance: {
        "pack-problem": {
          source: "pack",
          packId: "com.example.cloud-pack",
          packVersion: "1.0.0",
          contentDigest: "sha256-abc",
        },
      },
    });
    expect(JSON.parse(define["process.env.BATTLE_PROBLEMS_PROVENANCE"])).toBe(
      JSON.stringify({
        "pack-problem": {
          source: "pack",
          packId: "com.example.cloud-pack",
          packVersion: "1.0.0",
          contentDigest: "sha256-abc",
        },
      }),
    );
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

  // [#1412] sakura/apprun deploy 用に per-team Sakura API-key SecureString を decrypt 取得する
  // grant が必要。 ExternalId path と同様 prefix-scope された ARN が deploy Lambda の policy に乗っていること。
  it("should grant ssm:GetParameter on the per-team Sakura API-key SecureString path (#1412)", () => {
    const serialized = JSON.stringify(tpl.findResources("AWS::IAM::Policy"));
    expect(serialized).toContain("tenants/*/teams/*/sakura-api-key");
  });

  // [#1410] azure/bicep deploy も per-team Azure credential を decrypt 取得する。
  it("should grant ssm:GetParameter on the per-team Azure credential SecureString path (#1410)", () => {
    const serialized = JSON.stringify(tpl.findResources("AWS::IAM::Policy"));
    expect(serialized).toContain("tenants/*/teams/*/azure-credential");
  });

  // [#1411] gcp/infra-manager deploy も per-team GCP WIF config を decrypt 取得する。
  it("should grant ssm:GetParameter on the per-team GCP credential SecureString path (#1411)", () => {
    const serialized = JSON.stringify(tpl.findResources("AWS::IAM::Policy"));
    expect(serialized).toContain("tenants/*/teams/*/gcp-credential");
  });

  it("EventApi Lambda env should not include BATTLE_PROBLEMS_RUNTIMES (#2571 define channel only)", () => {
    // Issue #2571: BATTLE_PROBLEMS_RUNTIMES は BATTLE_PROBLEMS_CATALOG / _DISRUPTIONS /
    // _PROVENANCE と同じ esbuild bundling.define channel に載る (= 4KB env 上限回避、#1308)。
    // handler は process.env.BATTLE_PROBLEMS_RUNTIMES を読む既存 code のまま。
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
    expect(vars.BATTLE_PROBLEMS_RUNTIMES).toBeUndefined();
  });

  it("EventApi Lambda bundling define should include the runtime catalog (#2571)", () => {
    const define = eventApiBundlingDefine({
      problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
      problemsDisruptions: {},
      problemRuntimes: {
        "battle-non-aws": { provider: "sakura", engine: "apprun", entry: "template.yaml" },
      },
    });
    expect(JSON.parse(define["process.env.BATTLE_PROBLEMS_RUNTIMES"])).toBe(
      JSON.stringify({
        "battle-non-aws": { provider: "sakura", engine: "apprun", entry: "template.yaml" },
      }),
    );
  });

  // Issue #2571: Bulk Deploy (event-handler) の adapter dispatch が非 AWS single-provider 問題の
  // per-team credential 登録有無を確認 + 取得するため、DeployApi と同型の SSM/KMS grant を
  // EventApi role にも付与する。DeployApi / GenericScoring も同じ credential パス文字列を policy に
  // 持つため、テンプレート全体ではなく EventApi の DefaultPolicy に scope して assert する
  // (#1313 の EventApi policy 特定パターンを踏襲)。
  describe("EventApi non-AWS credential grants (#2571)", () => {
    function findEventApiPolicyStatements(): ReadonlyArray<Record<string, unknown>> {
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
      return stmt ?? [];
    }

    it("should grant ssm:GetParameter on the per-team sakura/azure/gcp credential paths to EventApi", () => {
      const serialized = JSON.stringify(findEventApiPolicyStatements());
      expect(serialized).toContain("tenants/*/teams/*/sakura-api-key");
      expect(serialized).toContain("tenants/*/teams/*/azure-credential");
      expect(serialized).toContain("tenants/*/teams/*/gcp-credential");
    });

    it("should grant kms:Decrypt on EventApi scoped by the credential parameter EncryptionContext", () => {
      const statements = findEventApiPolicyStatements();
      const kmsStatement = statements.find((s) => {
        const action = (s as { Action?: string | string[] }).Action;
        const actions = Array.isArray(action) ? action : [action];
        return actions.includes("kms:Decrypt");
      });
      expect(kmsStatement).toBeDefined();
      const condition = (kmsStatement as { Condition?: Record<string, unknown> })?.Condition;
      const stringLike = condition?.StringLike as Record<string, unknown> | undefined;
      expect(stringLike?.["kms:EncryptionContext:PARAMETER_ARN"]).toBeDefined();
      const serialized = JSON.stringify(stringLike?.["kms:EncryptionContext:PARAMETER_ARN"]);
      expect(serialized).toContain("tenants/*/teams/*/sakura-api-key");
      expect(serialized).toContain("tenants/*/teams/*/azure-credential");
      expect(serialized).toContain("tenants/*/teams/*/gcp-credential");
    });

    it("should NOT grant the ExternalId parameter path to EventApi", () => {
      // Bulk 非 AWS dispatch は ExternalId を読まない (AWS bulk path は parameter 名だけを event
      // detail に詰め、復号は downstream の DeployApi/Worker Lambda が行う)。
      const serialized = JSON.stringify(findEventApiPolicyStatements());
      expect(serialized).not.toContain("tenants/*/external-id");
    });
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
    // [#1665] operator-fired disruption の active 採点効果を解決する audit table。
    expect(vars.DISRUPTIONS_TABLE_NAME).toBeDefined();
    // scheduled auto-teardown を有効化する CompetitorAccounts table 名 env。
    expect(vars.COMPETITOR_ACCOUNTS_TABLE_NAME).toBeDefined();
    // scheduled auto-deploy を有効化する Teams table 名 env。
    expect(vars.TEAMS_TABLE_NAME).toBeDefined();
    expect(vars.BATTLE_PROBLEMS_SCORING).toBeUndefined();
    expect(vars.PROBLEM_ENDPOINTS).toBeUndefined();
    expect(vars.BATTLE_PROBLEMS_PHASES).toBeUndefined();
    // catalog は esbuild define で build 時 literal 化するので env からは除く。
    expect(vars.BATTLE_PROBLEMS_CATALOG).toBeUndefined();
    // [Issue #2571] scheduled auto-deploy adapter dispatch 用 runtime catalog も同じ esbuild
    // define channel に載る (= EventApi と同型、4KB env 上限回避)。
    expect(vars.BATTLE_PROBLEMS_RUNTIMES).toBeUndefined();
  });

  it("GenericScoring Lambda role should be granted read on the Teams table for scheduled deploy", () => {
    // scheduled auto-deploy が bulkDeployEvent で event の teams を Query する (= read-only)。
    // CodeRabbit #2010: 「どこかの policy に dynamodb:Query があれば pass」では Teams grant の
    // 回帰を捕まえられないので、 (a) GenericScoring role の policy に限定し、 (b) Resource が
    // Teams table の Arn を指す statement に scope して pin する。
    const teamsTableId = Object.keys(tpl.findResources("AWS::DynamoDB::Table")).find((id) =>
      id.startsWith("Teams"),
    );
    expect(teamsTableId).toBeDefined();

    const policies = tpl.findResources("AWS::IAM::Policy");
    const grantsTeamsRead = Object.entries(policies).some(([name, p]) => {
      if (!name.includes("GenericScoring")) return false;
      const statements =
        (p as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } }).Properties
          ?.PolicyDocument?.Statement ?? [];
      return statements.some((s) => {
        const action = (s as { Action?: string | string[] }).Action;
        const actions = Array.isArray(action) ? action : [action];
        if (!actions.includes("dynamodb:Query")) return false;
        const resource = (s as { Resource?: unknown }).Resource;
        const resources = Array.isArray(resource) ? resource : [resource];
        return resources.some(
          (r) => (r as { "Fn::GetAtt"?: unknown[] })?.["Fn::GetAtt"]?.[0] === teamsTableId,
        );
      });
    });
    expect(grantsTeamsRead).toBe(true);
  });

  it("GenericScoring Lambda should receive the deploy event bus name for condition-triggered disruptions (#1422)", () => {
    // #1422: condition-triggered disruption の publish 先 bus を env で渡す。 catalog
    // (BATTLE_PROBLEMS_DISRUPTIONS) は scoring / phases 同様 esbuild define で build 時 literal 化し env から除く。
    const functions = tpl.findResources("AWS::Lambda::Function");
    const genericScoring = Object.entries(functions).find(
      ([name]) => name.includes("GenericScoring") && name.includes("Function"),
    );
    const vars =
      (
        genericScoring?.[1] as {
          Properties?: { Environment?: { Variables?: Record<string, unknown> } };
        }
      )?.Properties?.Environment?.Variables ?? {};
    expect(vars.DEPLOY_EVENT_BUS_NAME).toBeDefined();
    expect(vars.BATTLE_PROBLEMS_DISRUPTIONS).toBeUndefined();
  });

  it("GenericScoring Lambda role should be granted events:PutEvents (#1422)", () => {
    // grantPutEventsTo が当該 bus に scope した events:PutEvents statement を出すことを pin。
    const policies = tpl.findResources("AWS::IAM::Policy");
    const hasPutEvents = Object.values(policies).some((p) => {
      const statements =
        (p as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } }).Properties
          ?.PolicyDocument?.Statement ?? [];
      return statements.some((s) => {
        const action = (s as { Action?: string | string[] }).Action;
        return Array.isArray(action)
          ? action.includes("events:PutEvents")
          : action === "events:PutEvents";
      });
    });
    expect(hasPutEvents).toBe(true);
  });

  // [#1410-1412] runtime status reconciler が非 AWS credential を decrypt 取得する。
  it("should grant ssm:GetParameter on the per-team credential paths + DEPLOY_ENVIRONMENT env (#1410-1412)", () => {
    const functions = tpl.findResources("AWS::Lambda::Function");
    const genericScoring = Object.entries(functions).find(
      ([name]) => name.includes("GenericScoring") && name.includes("Function"),
    );
    const vars =
      (
        genericScoring?.[1] as {
          Properties?: { Environment?: { Variables?: Record<string, unknown> } };
        }
      )?.Properties?.Environment?.Variables ?? {};
    expect(vars.DEPLOY_ENVIRONMENT).toBeDefined();
    const policies = JSON.stringify(tpl.findResources("AWS::IAM::Policy"));
    expect(policies).toContain("tenants/*/teams/*/sakura-api-key");
    expect(policies).toContain("tenants/*/teams/*/azure-credential");
    expect(policies).toContain("tenants/*/teams/*/gcp-credential");
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

  it("EventApi Role should grant scheduler:DeleteSchedule scoped to tc-recur-*", () => {
    // recurring disruption の早期解除 (operator 一覧→Cancel) が executor の作った rate schedule を
    // 消すための最小権限。 resource は tc-recur-* に scope する (= 任意 schedule は消せない)。
    const policies = tpl.findResources("AWS::IAM::Policy");
    const serialized = JSON.stringify(policies);
    expect(serialized).toContain("scheduler:DeleteSchedule");
    expect(serialized).toContain("schedule/default/tc-recur-*");
  });
});

describe("ProblemDeployBackendStack (MVP-1) — Competitor Accounts API Lambda (Issue #459)", () => {
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

  // [#1413] per-team cloud credential onboarding は同 Lambda が sakura/azure/gcp の
  // SecureString を Put/Delete/Get する。 3 provider 分の path prefix ARN が policy に乗っていること。
  it("should grant SSM access on the per-team sakura/azure/gcp credential SecureString paths (#1413)", () => {
    const serialized = JSON.stringify(tpl.findResources("AWS::IAM::Policy"));
    expect(serialized).toContain("tenants/*/teams/*/sakura-api-key");
    expect(serialized).toContain("tenants/*/teams/*/azure-credential");
    expect(serialized).toContain("tenants/*/teams/*/gcp-credential");
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

// The tenant-facing admin Hono handlers (deploy / events+feature-flags / competitor-accounts)
// were OOMing or timing out on their old 256/512MB in production: at those sizes the process
// hit Runtime.OutOfMemory during init (measured init peak ~676MB for competitor-accounts) or
// got too little CPU to finish init inside the timeout. A dead Lambda makes API Gateway return
// a 502 WITHOUT CORS headers, so the browser only saw "Failed to fetch". Pin the raised sizes so
// a future edit can't silently drop them back under the measured ceiling.
describe("ProblemDeployBackendStack — admin API Lambdas memory (OOM/timeout fix)", () => {
  const tpl = synthDefault();

  const memoryOf = (nameFragment: string): number => {
    const functions = tpl.findResources("AWS::Lambda::Function");
    const entry = Object.entries(functions).find(
      ([name]) => name.includes(nameFragment) && name.includes("Function"),
    );
    expect(entry, `Lambda matching ${nameFragment} should exist`).toBeDefined();
    const [, resource] = entry as [string, { Properties?: { MemorySize?: number } }];
    return resource.Properties?.MemorySize ?? 0;
  };

  it("DeployApi Lambda should be provisioned at 1024MB (was 256MB → init timeout)", () => {
    expect(memoryOf("DeployApi")).toBe(1024);
  });

  it("EventApi Lambda should be provisioned at 1024MB (was 512MB → cold-start OOM)", () => {
    expect(memoryOf("EventApi")).toBe(1024);
  });

  it("CompetitorAccounts Lambda should be provisioned at 1024MB (was 256MB → init OOM)", () => {
    expect(memoryOf("CompetitorAccounts")).toBe(1024);
  });
});

// Issue #2647: the same init-OOM class as the admin API Lambdas above, on the Turso profile.
// These writers resolve their repository through the control-data runtime, so on a pure SQL
// backend they load `@libsql/client/http` on top of the AWS SDK during init. At 256MB
// DeployStatusWriter died with Runtime.OutOfMemory (measured live: Max Memory Used 256MB of
// 256MB, killed 1253ms in) — and because that writer is what records deploy completion, every
// deploy stayed "in progress" forever and no event could start. DeployStatusWriter is only
// synthesized on a pure SQL backend, so `synthDefault()` cannot see it: assert against the
// Turso synth or this regression stays invisible.
describe("ProblemDeployBackendStack — control-data writer Lambdas memory on Turso (#2647)", () => {
  const tpl = synthWithControlDataBackendTurso();

  const memoryOf = (nameFragment: string): number => {
    const functions = tpl.findResources("AWS::Lambda::Function");
    const entry = Object.entries(functions).find(
      ([name]) => name.includes(nameFragment) && name.includes("Function"),
    );
    expect(entry, `Lambda matching ${nameFragment} should exist`).toBeDefined();
    const [, resource] = entry as [string, { Properties?: { MemorySize?: number } }];
    return resource.Properties?.MemorySize ?? 0;
  };

  it("DeployStatusWriter Lambda should use the live-verified 2048MB safety value", () => {
    expect(memoryOf("DeployStatusWriter")).toBe(2048);
  });

  it("ExternalIdAudit Lambda should be provisioned at 1024MB (same control-data runtime)", () => {
    expect(memoryOf("ExternalIdAudit")).toBe(1024);
  });

  it("SystemAuditWriter Lambda should be provisioned at 1024MB (same control-data runtime)", () => {
    expect(memoryOf("SystemAuditWriter")).toBe(1024);
  });
});
