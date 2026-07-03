import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { synthParticipantPortalLambdaOnly } from "./problem-deploy-backend-stack.test-helpers";

describe("ParticipantPortalLambda wiring (#535)", () => {
  const tpl = synthParticipantPortalLambdaOnly();

  it("should set EVENTS_TABLE_NAME in the ParticipantPortal Lambda environment", () => {
    // ADR-006 Notifications backend (PR-524) が Module load 時に EVENTS_TABLE_NAME を
    // 必須で読むので、CDK 配線が無いと Lambda init で throw して portal 全 route が
    // 502 になる (= #535 regression)。本 assertion で再発防止。
    tpl.hasResourceProperties(
      "AWS::Lambda::Function",
      Match.objectLike({
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            DEPLOYMENTS_TABLE_NAME: Match.anyValue(),
            EVENTS_TABLE_NAME: Match.anyValue(),
          }),
        }),
      }),
    );
  });

  it("should grant Events-table dynamodb:Query + GetItem to the ParticipantPortal Lambda IAM Role", () => {
    // ADR-006: GET /portal/me/notifications が Events table を Query する (= partition 単位)。
    // Issue #1005: submit-flag / hint reveal が共有する event-gate.ts が PK=EVENT#<id> /
    // SK=META を `dynamodb:GetItem` で 1 行引く (= scoring gate)。 grant が漏れていると
    // AccessDenied で getEventGate が undefined を返し、 fail-closed で `scoring_not_started`
    // に倒れ 「Event 採点中なのに flag 提出が reject される」 不整合になる (= 実 deploy で
    // 観測した regression、 CloudWatch logs `[event-gate] getEventGate failed AccessDenied`)。
    // 配線が無いと AccessDenied で 500 / 提出 reject になる。 Role 直貼りの inline policy
    // なので `AWS::IAM::Role` の Policies 配列を見る。
    tpl.hasResourceProperties(
      "AWS::IAM::Role",
      Match.objectLike({
        Policies: Match.arrayWith([
          Match.objectLike({
            PolicyName: "EventsRead",
            PolicyDocument: Match.objectLike({
              Statement: Match.arrayWith([
                Match.objectLike({
                  Action: Match.arrayWith(["dynamodb:Query", "dynamodb:GetItem"]),
                  Effect: "Allow",
                }),
              ]),
            }),
          }),
        ]),
      }),
    );
  });

  it("ADR-012 Phase 3.A: should set PROBLEM_ENDPOINTS_TABLE_NAME env without the catalog env", () => {
    // Issue #1158: PROBLEM_ENDPOINTS / BATTLE_PROBLEMS_SCORING は env 4 KB 上限回避のため
    // esbuild bundling.define で build 時 literal 置換し、 Lambda env からは取り除いている。
    tpl.hasResourceProperties(
      "AWS::Lambda::Function",
      Match.objectLike({
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            PROBLEM_ENDPOINTS_TABLE_NAME: Match.anyValue(),
          }),
        }),
      }),
    );
    const functions = tpl.findResources("AWS::Lambda::Function");
    const participantPortal = Object.entries(functions).find(
      ([name]) => name.includes("ParticipantPortal") && name.includes("Function"),
    );
    expect(participantPortal).toBeDefined();
    const vars =
      (
        participantPortal?.[1] as {
          Properties?: { Environment?: { Variables?: Record<string, unknown> } };
        }
      )?.Properties?.Environment?.Variables ?? {};
    expect(vars.PROBLEM_ENDPOINTS).toBeUndefined();
    expect(vars.BATTLE_PROBLEMS_SCORING).toBeUndefined();
  });

  it("should have DEPLOY_ENVIRONMENT for AWS Console SSO", () => {
    const functions = tpl.findResources("AWS::Lambda::Function");
    const fn = Object.values(functions)[0] as {
      Properties?: { Environment?: { Variables?: Record<string, unknown> } };
    };
    const vars = fn.Properties?.Environment?.Variables ?? {};
    expect(vars.DEPLOY_ENVIRONMENT).toBe("development");
  });

  it("should have SSM ExternalId read and CompetitorDeployRole AssumeRole permissions for AWS Console SSO", () => {
    tpl.hasResourceProperties(
      "AWS::IAM::Role",
      Match.objectLike({
        Policies: Match.arrayWith([
          Match.objectLike({
            PolicyName: "ConsoleSso",
            PolicyDocument: Match.objectLike({
              Statement: Match.arrayWith([
                Match.objectLike({
                  Action: "ssm:GetParameter",
                  Effect: "Allow",
                }),
                Match.objectLike({
                  Action: "sts:AssumeRole",
                  Effect: "Allow",
                  Resource: "arn:aws:iam::*:role/TenkaCloud-*",
                }),
              ]),
            }),
          }),
        ]),
      }),
    );
  });

  it("ADR-012 Phase 3.A: should grant Endpoints table Query / PutItem / DeleteItem to the IAM Role", () => {
    tpl.hasResourceProperties(
      "AWS::IAM::Role",
      Match.objectLike({
        Policies: Match.arrayWith([
          Match.objectLike({
            PolicyName: "EndpointsRW",
            PolicyDocument: Match.objectLike({
              Statement: Match.arrayWith([
                Match.objectLike({
                  Action: Match.arrayWith([
                    "dynamodb:Query",
                    "dynamodb:PutItem",
                    "dynamodb:DeleteItem",
                  ]),
                  Effect: "Allow",
                }),
              ]),
            }),
          }),
        ]),
      }),
    );
  });

  it("should grant scoped codebuild:BatchGetBuilds + logs:GetLogEvents for deploy-log streaming", () => {
    // Bug fix: `GET /portal/me/deploy-logs` (deploy-logs.ts) calls codebuild:BatchGetBuilds then
    // logs:GetLogEvents to stream a team's deploy build log. The participant role granted neither,
    // so the route returned AccessDenied in production. Assert both grants exist, on the
    // DeployLogsRead inline policy, scoped to the deploy project (not `*`).
    tpl.hasResourceProperties(
      "AWS::IAM::Role",
      Match.objectLike({
        Policies: Match.arrayWith([
          Match.objectLike({
            PolicyName: "DeployLogsRead",
            PolicyDocument: Match.objectLike({
              Statement: Match.arrayWith([
                Match.objectLike({ Action: "codebuild:BatchGetBuilds", Effect: "Allow" }),
                Match.objectLike({ Action: "logs:GetLogEvents", Effect: "Allow" }),
              ]),
            }),
          }),
        ]),
      }),
    );

    // Least-privilege: neither statement uses a `*` resource. BatchGetBuilds is scoped to the
    // deploy project ARN; GetLogEvents is scoped to its `/aws/codebuild/<projectName>` log group.
    const roles = tpl.findResources("AWS::IAM::Role");
    const portalRole = Object.values(roles).find((r) =>
      (
        (r as { Properties?: { Policies?: Array<{ PolicyName?: string }> } }).Properties
          ?.Policies ?? []
      ).some((p) => p.PolicyName === "DeployLogsRead"),
    );
    expect(portalRole).toBeDefined();
    const deployLogsPolicy = (
      portalRole as {
        Properties?: {
          Policies?: Array<{
            PolicyName?: string;
            PolicyDocument?: { Statement?: Array<{ Action?: unknown; Resource?: unknown }> };
          }>;
        };
      }
    ).Properties?.Policies?.find((p) => p.PolicyName === "DeployLogsRead");
    const statements = deployLogsPolicy?.PolicyDocument?.Statement ?? [];

    const codebuild = statements.find((s) => s.Action === "codebuild:BatchGetBuilds");
    expect(codebuild?.Resource).not.toBe("*");
    // Project ARN (`arn:...:codebuild:...:project/...`) — scoped to the deploy project.
    expect(JSON.stringify(codebuild?.Resource)).toContain(":project/");

    const logs = statements.find((s) => s.Action === "logs:GetLogEvents");
    expect(logs?.Resource).not.toBe("*");
    // CloudWatch log group for the CodeBuild project, streams covered by the trailing `:*`.
    expect(JSON.stringify(logs?.Resource)).toContain("/aws/codebuild/");
  });
});
