import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { UserPool } from "aws-cdk-lib/aws-cognito";
import { Table } from "aws-cdk-lib/aws-dynamodb";
import { describe, expect, it } from "vitest";
import { AdminConsoleInsightStack } from "../../lib/admin-insight/admin-console-insight-stack";

/**
 * Issue #590: AdminConsoleInsightStack の CFn 構造を assertion で固定する。
 * cross-stack 参照を simulate するため UserPool / Tables は同 app 内 helper stack に作る。
 */
function synthInsightStack(adminConsoleOrigin?: string, costBudgetName?: string): Template {
  const app = new cdk.App({ autoSynth: false });
  const fixtures = new cdk.Stack(app, "Fixtures", {
    env: { account: "123456789012", region: "ap-northeast-1" },
  });
  const userPool = new UserPool(fixtures, "UserPool", {
    selfSignUpEnabled: false,
  });
  const userPoolClient = userPool.addClient("UserClient");
  const deployments = new Table(fixtures, "Deployments", {
    partitionKey: { name: "PK", type: cdk.aws_dynamodb.AttributeType.STRING },
    sortKey: { name: "SK", type: cdk.aws_dynamodb.AttributeType.STRING },
  });
  const events = new Table(fixtures, "Events", {
    partitionKey: { name: "PK", type: cdk.aws_dynamodb.AttributeType.STRING },
    sortKey: { name: "SK", type: cdk.aws_dynamodb.AttributeType.STRING },
  });
  const teams = new Table(fixtures, "Teams", {
    partitionKey: { name: "PK", type: cdk.aws_dynamodb.AttributeType.STRING },
    sortKey: { name: "SK", type: cdk.aws_dynamodb.AttributeType.STRING },
  });

  const stack = new AdminConsoleInsightStack(app, "InsightStack", {
    env: { account: "123456789012", region: "ap-northeast-1" },
    cognitoUserPool: userPool,
    cognitoUserClientId: userPoolClient.userPoolClientId,
    deploymentsTable: deployments,
    eventsTable: events,
    teamsTable: teams,
    adminConsoleOrigin,
    provisioningStateMachineArn:
      "arn:aws:states:ap-northeast-1:123456789012:stateMachine:provisioningJobRunner",
    ...(costBudgetName ? { costBudgetName } : {}),
  });
  return Template.fromStack(stack);
}

describe("AdminConsoleInsightStack", () => {
  describe("Lambda", () => {
    it("should provision 1 AdminInsight Lambda on Node.js 22 / arm64", () => {
      const tpl = synthInsightStack();
      tpl.resourceCountIs("AWS::Lambda::Function", 1);
      tpl.hasResourceProperties(
        "AWS::Lambda::Function",
        Match.objectLike({
          Runtime: "nodejs22.x",
          Architectures: ["arm64"],
        }),
      );
      // 実 bundling を伴う synth はデフォルト 15s では負荷時に marginal(CI 実測 ~12.4s)。
    }, 60_000);

    it("should pass Deployments / Events / Teams table names to Lambda env", () => {
      const tpl = synthInsightStack();
      tpl.hasResourceProperties(
        "AWS::Lambda::Function",
        Match.objectLike({
          Environment: Match.objectLike({
            Variables: Match.objectLike({
              DEPLOYMENTS_TABLE_NAME: Match.anyValue(),
              EVENTS_TABLE_NAME: Match.anyValue(),
              TEAMS_TABLE_NAME: Match.anyValue(),
            }),
          }),
        }),
      );
    });
  });

  describe("HTTP API + Cognito JWT Authorizer", () => {
    it("should have 1 HTTP API (API GW v2)", () => {
      const tpl = synthInsightStack();
      tpl.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
    });

    it("should have a JWT Authorizer (linked to Cognito UserPool)", () => {
      const tpl = synthInsightStack();
      tpl.hasResourceProperties(
        "AWS::ApiGatewayV2::Authorizer",
        Match.objectLike({
          AuthorizerType: "JWT",
          IdentitySource: ["$request.header.Authorization"],
        }),
      );
    });

    it("GET /admin/insight/tenants/summary route should be wired to the JWT Authorizer", () => {
      const tpl = synthInsightStack();
      const routes = tpl.findResources("AWS::ApiGatewayV2::Route", {
        Properties: { RouteKey: "GET /admin/insight/tenants/summary" },
      });
      expect(Object.keys(routes)).toHaveLength(1);
      const route = Object.values(routes)[0] as {
        Properties: { AuthorizerId: unknown; AuthorizationType: string };
      };
      expect(route.Properties.AuthorizationType).toBe("JWT");
      expect(route.Properties.AuthorizerId).toBeDefined();
    });

    it("should have the 4 Phase 1.B drill-down routes (events / event detail / deployment / stack-progress)", () => {
      const tpl = synthInsightStack();
      const expected = [
        "GET /admin/insight/tenants/{tenantId}/events",
        "GET /admin/insight/tenants/{tenantId}/events/{eventId}",
        "GET /admin/insight/tenants/{tenantId}/deployments/{jobId}",
        "GET /admin/insight/tenants/{tenantId}/deployments/{jobId}/stack-progress",
      ];
      for (const routeKey of expected) {
        const routes = tpl.findResources("AWS::ApiGatewayV2::Route", {
          Properties: { RouteKey: routeKey },
        });
        expect(Object.keys(routes), `route ${routeKey} should exist`).toHaveLength(1);
        const route = Object.values(routes)[0] as {
          Properties: { AuthorizationType: string };
        };
        expect(route.Properties.AuthorizationType).toBe("JWT");
      }
    });

    it("should include localhost dev in CORS allowOrigins", () => {
      const tpl = synthInsightStack();
      tpl.hasResourceProperties(
        "AWS::ApiGatewayV2::Api",
        Match.objectLike({
          CorsConfiguration: Match.objectLike({
            AllowOrigins: Match.arrayWith([
              "http://localhost:5173",
              "http://localhost:4173",
              "http://localhost:4180",
            ]),
            AllowMethods: Match.arrayWith(["GET", "OPTIONS"]),
          }),
        }),
      );
    });

    it("should add adminConsoleOrigin (equivalent to CDK_PARAM_ADMIN_CONSOLE_ORIGIN) to CORS", () => {
      const tpl = synthInsightStack("https://abc.cloudfront.net");
      tpl.hasResourceProperties(
        "AWS::ApiGatewayV2::Api",
        Match.objectLike({
          CorsConfiguration: Match.objectLike({
            AllowOrigins: Match.arrayWith(["https://abc.cloudfront.net"]),
          }),
        }),
      );
    });
  });

  describe("IAM 権限 (read-only)", () => {
    function collectActions(tpl: Template): string[] {
      const policies = tpl.findResources("AWS::IAM::Policy");
      return Object.values(policies).flatMap(policyActions);
    }

    function policyActions(policy: unknown): string[] {
      const statements = (policy as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } })
        .Properties?.PolicyDocument?.Statement;
      return (statements ?? []).flatMap(statementActions);
    }

    function statementActions(statement: unknown): string[] {
      const action = (statement as { Action?: string | string[] }).Action;
      if (Array.isArray(action)) return action;
      return typeof action === "string" ? [action] : [];
    }

    it("should Allow only reads on Deployments / Events / Teams tables (no writes)", () => {
      const tpl = synthInsightStack();
      // Lambda role に attach された IAM Policy の中に DynamoDB write action が無いことを
      // 強めに検証する (= 旧 grantReadWriteData で誤 wire したら test が落ちる)。
      const writeActions = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"];
      const allActions = collectActions(tpl);
      for (const w of writeActions) {
        expect(allActions).not.toContain(w);
      }
      // 同時に read action は最低 1 つ (Query / GetItem) 含むこと。
      expect(allActions.some((a) => a === "dynamodb:Query" || a === "dynamodb:GetItem")).toBe(true);
    });

    it("Phase 1.B: should grant Teams-table read (#598)", () => {
      const tpl = synthInsightStack();
      // Teams は Phase 1.A では env 注入のみだったが、Phase 1.B drill-down で read 権限を
      // 追加する。Policy が Teams table の ARN を参照する Statement を 1 つ以上持つこと。
      const policies = tpl.findResources("AWS::IAM::Policy");
      const policyJsonAll = JSON.stringify(policies);
      // CDK は Table.tableArn を Fn::GetAtt で参照するので、policy JSON 内に Teams<HashSuffix>
      // / TeamsResource 等のリソース名が含まれる。tableName よりも logicalId で固定。
      expect(policyJsonAll).toContain("Teams");
    });

    it("Phase 1.B: should grant CFn DescribeStackEvents / DescribeStackResources (#598)", () => {
      const tpl = synthInsightStack();
      const allActions = collectActions(tpl);
      expect(allActions).toContain("cloudformation:DescribeStackEvents");
      expect(allActions).toContain("cloudformation:DescribeStackResources");
    });
  });

  describe("#1392: dead system-users routes + unused Cognito Admin* IAM removed", () => {
    // Regression: the Provisioning Jobs page read CodePipeline executions, so real tenant
    // provisioning was invisible. The tab now reads the SBT provisioning state machine, which
    // needs BOTH the route registration and the env/IAM below — PR-683 shipped a handler + IAM
    // without the route, and the resulting unmatched-404 carries no CORS header, so the browser
    // reports only "Failed to fetch".
    it("should register the provisioning-executions route", () => {
      const tpl = synthInsightStack();
      const routes = tpl.findResources("AWS::ApiGatewayV2::Route", {
        Properties: { RouteKey: "GET /admin/insight/provisioning-executions" },
      });
      expect(Object.keys(routes)).toHaveLength(1);
    });

    it("should pass the provisioning state machine ARN to the Lambda env", () => {
      const tpl = synthInsightStack();
      tpl.hasResourceProperties("AWS::Lambda::Function", {
        Environment: {
          Variables: Match.objectLike({
            PROVISIONING_STATE_MACHINE_ARN:
              "arn:aws:states:ap-northeast-1:123456789012:stateMachine:provisioningJobRunner",
          }),
        },
      });
    });

    it("should grant ListExecutions on the provisioning state machine", () => {
      const tpl = synthInsightStack();
      tpl.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: ["states:ListExecutions", "states:DescribeExecution"],
              Resource: Match.arrayWith([
                "arn:aws:states:ap-northeast-1:123456789012:stateMachine:provisioningJobRunner",
              ]),
            }),
          ]),
        },
      });
    });

    it("should NOT register any /admin/insight/system-users route (handler was removed)", () => {
      const tpl = synthInsightStack();
      tpl.resourcePropertiesCountIs(
        "AWS::ApiGatewayV2::Route",
        { RouteKey: Match.stringLikeRegexp("system-users") },
        0,
      );
    });

    it("should NOT grant cognito-idp:Admin* on any IAM policy (no standing privilege)", () => {
      const tpl = synthInsightStack();
      tpl.resourcePropertiesCountIs(
        "AWS::IAM::Policy",
        {
          PolicyDocument: {
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: Match.arrayWith(["cognito-idp:AdminCreateUser"]),
              }),
            ]),
          },
        },
        0,
      );
    });
  });

  describe("Issue #1431: in-console cost panel", () => {
    it("should register GET /admin/insight/cost on the JWT Authorizer", () => {
      const tpl = synthInsightStack();
      const routes = tpl.findResources("AWS::ApiGatewayV2::Route", {
        Properties: { RouteKey: "GET /admin/insight/cost" },
      });
      expect(Object.keys(routes)).toHaveLength(1);
      const route = Object.values(routes)[0] as { Properties: { AuthorizationType: string } };
      expect(route.Properties.AuthorizationType).toBe("JWT");
    });

    it("should NOT grant budgets:ViewBudget when no budget is wired", () => {
      const tpl = synthInsightStack();
      function collectActions(t: Template): string[] {
        return Object.values(t.findResources("AWS::IAM::Policy")).flatMap((p) => {
          const s = (p as { Properties?: { PolicyDocument?: { Statement?: unknown[] } } })
            .Properties?.PolicyDocument?.Statement;
          return (s ?? []).flatMap((st) => {
            const a = (st as { Action?: string | string[] }).Action;
            return Array.isArray(a) ? a : typeof a === "string" ? [a] : [];
          });
        });
      }
      expect(collectActions(tpl)).not.toContain("budgets:ViewBudget");
    });

    it("should pass COST_BUDGET_NAME env + grant budgets:ViewBudget when a budget is wired", () => {
      const tpl = synthInsightStack(undefined, "tenkacloud-development-monthly-cost");
      tpl.hasResourceProperties(
        "AWS::Lambda::Function",
        Match.objectLike({
          Environment: Match.objectLike({
            Variables: Match.objectLike({
              COST_BUDGET_NAME: "tenkacloud-development-monthly-cost",
              COST_BUDGET_ACCOUNT_ID: "123456789012",
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
                Action: "budgets:ViewBudget",
                Resource:
                  "arn:aws:budgets::123456789012:budget/tenkacloud-development-monthly-cost",
              }),
            ]),
          }),
        }),
      );
    });
  });

  describe("Outputs", () => {
    it("should expose AdminInsightApiUrl as a stack Output", () => {
      const tpl = synthInsightStack();
      const outputs = tpl.findOutputs("*");
      expect(Object.keys(outputs)).toContain("AdminInsightApiUrl");
    });
  });

  describe("Issue #2438: control-plane data backend env wiring", () => {
    function synthWithControlDataBackend(props: {
      readonly controlDataBackend?: string;
      readonly tursoDatabaseUrl?: string;
      readonly tursoAuthTokenParameterName?: string;
    }): Template {
      const app = new cdk.App({ autoSynth: false });
      const fixtures = new cdk.Stack(app, "Fixtures2438", {
        env: { account: "123456789012", region: "ap-northeast-1" },
      });
      const userPool = new UserPool(fixtures, "UserPool", { selfSignUpEnabled: false });
      const userPoolClient = userPool.addClient("UserClient");
      const deployments = new Table(fixtures, "Deployments", {
        partitionKey: { name: "PK", type: cdk.aws_dynamodb.AttributeType.STRING },
        sortKey: { name: "SK", type: cdk.aws_dynamodb.AttributeType.STRING },
      });
      const events = new Table(fixtures, "Events", {
        partitionKey: { name: "PK", type: cdk.aws_dynamodb.AttributeType.STRING },
        sortKey: { name: "SK", type: cdk.aws_dynamodb.AttributeType.STRING },
      });
      const teams = new Table(fixtures, "Teams", {
        partitionKey: { name: "PK", type: cdk.aws_dynamodb.AttributeType.STRING },
        sortKey: { name: "SK", type: cdk.aws_dynamodb.AttributeType.STRING },
      });

      const stack = new AdminConsoleInsightStack(app, "InsightStack2438", {
        env: { account: "123456789012", region: "ap-northeast-1" },
        cognitoUserPool: userPool,
        cognitoUserClientId: userPoolClient.userPoolClientId,
        deploymentsTable: deployments,
        eventsTable: events,
        teamsTable: teams,
        ...props,
      });
      return Template.fromStack(stack);
    }

    it("should NOT add CONTROL_DATA_BACKEND by default (byte-compat, no regression)", () => {
      const tpl = synthWithControlDataBackend({});
      tpl.hasResourceProperties(
        "AWS::Lambda::Function",
        Match.objectLike({
          Environment: Match.objectLike({
            Variables: Match.not(Match.objectLike({ CONTROL_DATA_BACKEND: Match.anyValue() })),
          }),
        }),
      );
    });

    it("should inject CONTROL_DATA_BACKEND + Turso env and grant ssm:GetParameter when turso is selected", () => {
      const tpl = synthWithControlDataBackend({
        controlDataBackend: "turso",
        tursoDatabaseUrl: "libsql://example.turso.io",
        tursoAuthTokenParameterName: "/tenkacloud/development/turso-token",
      });
      tpl.hasResourceProperties(
        "AWS::Lambda::Function",
        Match.objectLike({
          Environment: Match.objectLike({
            Variables: Match.objectLike({
              CONTROL_DATA_BACKEND: "turso",
              TURSO_DATABASE_URL: "libsql://example.turso.io",
              TURSO_AUTH_TOKEN_PARAMETER_NAME: "/tenkacloud/development/turso-token",
            }),
          }),
        }),
      );
      tpl.hasResourceProperties(
        "AWS::IAM::Policy",
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({ Action: "ssm:GetParameter", Resource: Match.anyValue() }),
            ]),
          }),
        }),
      );
      expect(JSON.stringify(tpl.toJSON())).toContain(
        ":parameter/tenkacloud/development/turso-token",
      );
    });
  });

  describe("Issue #2440: eventsTable/teamsTable are optional (pure SQL backend)", () => {
    /**
     * `ProblemDeployBackendStack` does not synth Events/Teams tables when
     * `controlDataBackend` is a pure SQL value (turso|sql), so it hands `undefined` cross-stack
     * refs to `AdminConsoleInsightStack`. This must synth cleanly with no EVENTS_TABLE_NAME /
     * TEAMS_TABLE_NAME env and no read grant on a nonexistent table.
     */
    function synthWithoutEventsTeamsTables(): Template {
      const app = new cdk.App({ autoSynth: false });
      const fixtures = new cdk.Stack(app, "Fixtures2440", {
        env: { account: "123456789012", region: "ap-northeast-1" },
      });
      const userPool = new UserPool(fixtures, "UserPool", { selfSignUpEnabled: false });
      const userPoolClient = userPool.addClient("UserClient");
      const deployments = new Table(fixtures, "Deployments", {
        partitionKey: { name: "PK", type: cdk.aws_dynamodb.AttributeType.STRING },
        sortKey: { name: "SK", type: cdk.aws_dynamodb.AttributeType.STRING },
      });

      const stack = new AdminConsoleInsightStack(app, "InsightStack2440", {
        env: { account: "123456789012", region: "ap-northeast-1" },
        cognitoUserPool: userPool,
        cognitoUserClientId: userPoolClient.userPoolClientId,
        deploymentsTable: deployments,
        // eventsTable / teamsTable omitted (= undefined, mirroring the pure SQL backend).
        controlDataBackend: "turso",
        tursoDatabaseUrl: "libsql://example.turso.io",
        tursoAuthTokenParameterName: "/tenkacloud/development/turso-token",
      });
      return Template.fromStack(stack);
    }

    it("should synth without throwing and omit EVENTS_TABLE_NAME/TEAMS_TABLE_NAME env", () => {
      const tpl = synthWithoutEventsTeamsTables();
      tpl.hasResourceProperties(
        "AWS::Lambda::Function",
        Match.objectLike({
          Environment: Match.objectLike({
            Variables: Match.not(
              Match.objectLike({
                EVENTS_TABLE_NAME: Match.anyValue(),
                TEAMS_TABLE_NAME: Match.anyValue(),
              }),
            ),
          }),
        }),
      );
    });

    it("should grant read-only access to Deployments only (no dangling grant on a nonexistent Events/Teams table)", () => {
      const tpl = synthWithoutEventsTeamsTables();
      const policies = tpl.findResources("AWS::IAM::Policy");
      const actions = Object.values(policies).flatMap((p) =>
        (
          (
            p as {
              Properties?: { PolicyDocument?: { Statement?: Array<{ Action?: unknown }> } };
            }
          ).Properties?.PolicyDocument?.Statement ?? []
        ).flatMap((s) => ([] as unknown[]).concat(s.Action ?? [])),
      );
      // Turso SSM read is still granted (control-data seam), but no dynamodb grant references a
      // second/third table beyond Deployments (there is exactly 1 DynamoDB table in this stack's
      // fixtures, so any dynamodb:* grant necessarily scopes to it alone).
      expect(actions).toContain("ssm:GetParameter");
      const tableCount = Object.keys(tpl.findResources("AWS::DynamoDB::Table")).length;
      expect(tableCount).toBe(0); // Deployments lives in the Fixtures2440 stack, not this one.
    });
  });

  describe("Issue #2441 (Phase B PR-6): deploymentsTable is also optional (pure SQL backend)", () => {
    /**
     * `ProblemDeployBackendStack` does not synth the Deployments table either when
     * `controlDataBackend` is pure SQL, so it hands `undefined` for all three cross-stack
     * table refs. This must synth cleanly with no DEPLOYMENTS_TABLE_NAME env, no read grant
     * on a nonexistent table, and the tenant summary must still resolve deploy counts via
     * the repository seam (`countActiveByTenant`) rather than a raw DDB reference.
     */
    function synthWithoutAnyTables(): Template {
      const app = new cdk.App({ autoSynth: false });
      const fixtures = new cdk.Stack(app, "Fixtures2441", {
        env: { account: "123456789012", region: "ap-northeast-1" },
      });
      const userPool = new UserPool(fixtures, "UserPool", { selfSignUpEnabled: false });
      const userPoolClient = userPool.addClient("UserClient");

      const stack = new AdminConsoleInsightStack(app, "InsightStack2441", {
        env: { account: "123456789012", region: "ap-northeast-1" },
        cognitoUserPool: userPool,
        cognitoUserClientId: userPoolClient.userPoolClientId,
        // deploymentsTable / eventsTable / teamsTable all omitted (= undefined, mirroring the
        // pure SQL backend where ProblemDeployBackendStack synths none of the three).
        controlDataBackend: "turso",
        tursoDatabaseUrl: "libsql://example.turso.io",
        tursoAuthTokenParameterName: "/tenkacloud/development/turso-token",
      });
      return Template.fromStack(stack);
    }

    it("should synth without throwing and omit DEPLOYMENTS_TABLE_NAME env", () => {
      const tpl = synthWithoutAnyTables();
      tpl.hasResourceProperties(
        "AWS::Lambda::Function",
        Match.objectLike({
          Environment: Match.objectLike({
            Variables: Match.not(Match.objectLike({ DEPLOYMENTS_TABLE_NAME: Match.anyValue() })),
          }),
        }),
      );
    });

    it("should not add any dynamodb:* grant (zero DynamoDB tables cross-referenced)", () => {
      const tpl = synthWithoutAnyTables();
      const policies = tpl.findResources("AWS::IAM::Policy");
      const actions = Object.values(policies).flatMap((p) =>
        (
          (
            p as {
              Properties?: { PolicyDocument?: { Statement?: Array<{ Action?: unknown }> } };
            }
          ).Properties?.PolicyDocument?.Statement ?? []
        ).flatMap((s) => ([] as unknown[]).concat(s.Action ?? [])),
      );
      expect(actions.some((a) => String(a).startsWith("dynamodb:"))).toBe(false);
      expect(Object.keys(tpl.findResources("AWS::DynamoDB::Table"))).toHaveLength(0);
    });
  });
});
