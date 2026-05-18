import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { ParticipantPortalLambda } from "../lib/problem-deploy/participant-portal-lambda";
import { ProblemDeployBackendStack } from "../lib/problem-deploy/problem-deploy-backend-stack";

// 全 it() で同じ Template を使い回す。stack 構造は default props で固定なので、
// describe ブロック単位で 1 度 synth すれば 13 回 → 1 回に圧縮できる。
function synthDefault(): Template {
  const app = new cdk.App();
  const stack = new ProblemDeployBackendStack(app, "TestStack", {
    eventBusArn: "arn:aws:events:ap-northeast-1:123456789012:event-bus/test-bus",
    sourceBucketName: "test-source-bucket",
    sourceObjectKey: "source.zip",
    problemsCatalog: {
      "hello-world": "problems/challenges/hello-world",
    },
    problemsScoring: {},
    problemsEndpoints: {},
    environmentName: "development",
  });
  return Template.fromStack(stack);
}

describe("ProblemDeployBackendStack (MVP-1)", () => {
  const tpl = synthDefault();

  describe("Deployments DDB table", () => {
    it("DDB テーブルを Deployments / Events / Teams / CompetitorAccounts / ProblemEndpoints / Disruptions / AdminAuditLog の 7 つ持ち、各 PK/SK + PROVISIONED 1/1 であるべき", () => {
      // ADR-004 Phase 1 で Events / Teams、Issue #459 / ADR-002 Phase 2.1 で CompetitorAccounts、
      // ADR-012 Phase 3.A で ProblemEndpoints、 Issue #888 で Disruptions (Red Team audit + idempotency)、
      // Issue #950 (ADR-020 Phase D) で AdminAuditLog (admin 操作監査)。
      // 7 Table すべて DynamoDbLowCapacity Aspect で 1/1 PROVISIONED に均される。
      tpl.resourceCountIs("AWS::DynamoDB::Table", 7);
      tpl.hasResourceProperties(
        "AWS::DynamoDB::Table",
        Match.objectLike({
          ProvisionedThroughput: Match.objectLike({
            ReadCapacityUnits: 1,
            WriteCapacityUnits: 1,
          }),
          KeySchema: Match.arrayWith([
            Match.objectLike({ AttributeName: "PK", KeyType: "HASH" }),
            Match.objectLike({ AttributeName: "SK", KeyType: "RANGE" }),
          ]),
        }),
      );
    });

    it("expiresAt の TTL を有効化すべき", () => {
      tpl.hasResourceProperties(
        "AWS::DynamoDB::Table",
        Match.objectLike({
          TimeToLiveSpecification: Match.objectLike({
            AttributeName: "expiresAt",
            Enabled: true,
          }),
        }),
      );
    });
  });

  describe("Deploy API Lambda (tenant API から invoke される)", () => {
    it("Node.js 22 / arm64 で BATTLE_PROBLEMS_CATALOG env を持つべき", () => {
      tpl.hasResourceProperties(
        "AWS::Lambda::Function",
        Match.objectLike({
          Runtime: "nodejs22.x",
          Architectures: ["arm64"],
          Environment: Match.objectLike({
            Variables: Match.objectLike({
              BATTLE_PROBLEMS_CATALOG: JSON.stringify({
                "hello-world": "problems/challenges/hello-world",
              }),
            }),
          }),
        }),
      );
    });

    // #534: CFn StackEvents / StackResources を読む IAM Allow を持つべき
    // (= deploy job 詳細ページから直接 CFn API を叩くため)。
    it("CFn DescribeStackEvents / DescribeStackResources を Allow にすべき", () => {
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

  describe("CodeBuild Project (deploy-battles.sh を実行)", () => {
    it("CodeBuild Project を 1 つ作るべき", () => {
      tpl.resourceCountIs("AWS::CodeBuild::Project", 1);
    });

    it("CodeBuild は S3 source を読むべき", () => {
      tpl.hasResourceProperties(
        "AWS::CodeBuild::Project",
        Match.objectLike({
          Source: Match.objectLike({
            Type: "S3",
            Location: Match.stringLikeRegexp("test-source-bucket/source.zip"),
          }),
        }),
      );
    });

    it("`deployConcurrentBuildLimit` 未指定なら ConcurrentBuildLimit を出力しないべき (#538)", () => {
      // 未指定 = AWS account 全体の concurrent build quota (region default 60) を本 Project
      // でフルに使う既存挙動。本 stack の default props で synth した時点で property が
      // 出ていないことを保証する (= 既存運用への regression 防止)。
      const projects = tpl.findResources("AWS::CodeBuild::Project");
      const project = Object.values(projects)[0] as {
        Properties?: { ConcurrentBuildLimit?: number };
      };
      expect(project?.Properties?.ConcurrentBuildLimit).toBeUndefined();
    });
  });

  describe("CodeBuild Project concurrent build limit (#538)", () => {
    // synth が 5 個の NodejsFunction (= esbuild bundling) を走らせるため、default 5s では足りない。
    // 共有 fixture (`tpl = synthDefault()`) と別 props を渡すので別 instance での synth が必要。
    it("`deployConcurrentBuildLimit: 200` を渡したら CFn property に反映されるべき", () => {
      const app = new cdk.App();
      const stack = new ProblemDeployBackendStack(app, "TestStackWithLimit", {
        eventBusArn: "arn:aws:events:ap-northeast-1:123456789012:event-bus/test-bus",
        sourceBucketName: "test-source-bucket",
        sourceObjectKey: "source.zip",
        problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
        problemsScoring: {},
        problemsEndpoints: {},
        deployConcurrentBuildLimit: 200,
        environmentName: "development",
      });
      const limited = Template.fromStack(stack);
      limited.hasResourceProperties(
        "AWS::CodeBuild::Project",
        Match.objectLike({ ConcurrentBuildLimit: 200 }),
      );
    }, 30_000);
  });

  describe("Step Functions State Machine + EventBridge Rule", () => {
    it("Create / Delete / BulkCreate の State Machine を 3 つ作るべき (Issue #910 Phase 2.C.2.a)", () => {
      tpl.resourceCountIs("AWS::StepFunctions::StateMachine", 3);
    });

    it("Create State Machine は CodeBuild 起動前に PENDING → IN_PROGRESS の中間遷移を書くべき", () => {
      // RUN_JOB 同期 CodeBuild は 5〜15 分かかるため、この中間書込が無いと operator UI が
      // PENDING のまま固定して polling が機能していないように見える (#159 の再発防止)。
      const stateMachines = tpl.findResources("AWS::StepFunctions::StateMachine");
      const synthJson = JSON.stringify(stateMachines);
      expect(synthJson).toContain("MarkInProgress");
      expect(synthJson).toContain("IN_PROGRESS");
    });

    it("Create State Machine は完了/失敗時に CodeBuild buildId を Deployments row へ保存すべき", () => {
      const stateMachines = tpl.findResources("AWS::StepFunctions::StateMachine");
      const createStateMachine = Object.values(stateMachines)
        .map((stateMachine) => JSON.stringify(stateMachine))
        .find((definition) => definition.includes("StartDeployCodeBuild"));

      expect(createStateMachine).toBeDefined();
      expect(createStateMachine).toContain("MarkSucceeded");
      expect(createStateMachine).toContain("MarkFailed");
      expect(createStateMachine).toContain("PROBLEM_EXTERNAL_ID");
      expect(createStateMachine).toContain("$.detail.jobId");
      expect(createStateMachine).toContain(
        "stackId = :stackId, stackOutputs = :stackOutputs, buildId = :buildId",
      );
      expect(createStateMachine).toContain("#failureReason = :failureReason, buildId = :buildId");
      expect(createStateMachine).toContain("$.codebuild.Build.Id");
    });

    it("Create State Machine は CodeBuild timeout / AccessDenied を Catch して FAILED に倒すべき", () => {
      const stateMachines = tpl.findResources("AWS::StepFunctions::StateMachine");
      const createStateMachine = Object.values(stateMachines)
        .map((stateMachine) => JSON.stringify(stateMachine))
        .find((definition) => definition.includes("StartDeployCodeBuild"));

      expect(createStateMachine).toBeDefined();
      expect(createStateMachine).toContain("StartDeployCodeBuild");
      expect(createStateMachine).toContain("StartDeployCodeBuildCrossAccount");
      expect(createStateMachine).toContain("States.ALL");
      expect(createStateMachine).toContain("RouteFailedDeployment");
      expect(createStateMachine).toContain("MarkFailed");
      expect(createStateMachine).toContain("MarkFailedWithoutBuildId");
    });

    it("Create State Machine は ROLLBACK_COMPLETE を terminal failure として MarkFailed に倒すべき", () => {
      const stateMachines = tpl.findResources("AWS::StepFunctions::StateMachine");
      const createStateMachine = Object.values(stateMachines)
        .map((stateMachine) => JSON.stringify(stateMachine))
        .find((definition) => definition.includes("StartDeployCodeBuild"));

      expect(createStateMachine).toBeDefined();
      expect(createStateMachine).toContain("RouteDescribedStackStatus");
      expect(createStateMachine).toContain("UseStackStatusReasonAsFailureCause");
      expect(createStateMachine).toContain("$.cfn.Stacks[0].StackStatus");
      expect(createStateMachine).toContain("ROLLBACK_COMPLETE");
      expect(createStateMachine).toContain("CREATE_FAILED");
      expect(createStateMachine).toContain("UPDATE_ROLLBACK_COMPLETE");
      expect(createStateMachine).toContain("$.cfn.Stacks[0].StackStatusReason");
      expect(createStateMachine).toContain("MarkFailed");
    });

    it("Create State Machine は DescribeStacks を Lambda 経由で実行すべき (#762)", () => {
      const stateMachines = tpl.findResources("AWS::StepFunctions::StateMachine");
      const createStateMachine = Object.values(stateMachines)
        .map((stateMachine) => JSON.stringify(stateMachine))
        .find((definition) => definition.includes("StartDeployCodeBuild"));

      expect(createStateMachine).toBeDefined();
      expect(createStateMachine).toContain("RouteCreateInput");
      expect(createStateMachine).toContain("StartDeployCodeBuildCrossAccount");
      expect(createStateMachine).toContain("DescribeStack");
      expect(createStateMachine).toContain("DescribeStackFunction");
      expect(createStateMachine).not.toContain(
        "arn:aws:states:::aws-sdk:cloudformation:describeStacks",
      );
      expect(createStateMachine).not.toContain("States.Format('{}', $.detail.competitorRoleArn)");
    });

    it("Delete State Machine は AssumeRole metadata の有無を Choice で分岐し、欠落 path 参照で runtime 死しないべき (#758)", () => {
      const stateMachines = tpl.findResources("AWS::StepFunctions::StateMachine");
      const deleteStateMachine = Object.values(stateMachines)
        .map((stateMachine) => JSON.stringify(stateMachine))
        .find((definition) => definition.includes("StartDeleteCodeBuild"));

      expect(deleteStateMachine).toBeDefined();
      expect(deleteStateMachine).toContain("RouteDeleteInput");
      expect(deleteStateMachine).toContain("StartDeleteCodeBuildCrossAccount");
      expect(deleteStateMachine).toContain("InvalidAssumeRoleMetadata");
      expect(deleteStateMachine).toContain("$.detail.competitorRoleArn");
      expect(deleteStateMachine).toContain("$.detail.externalIdParameterName");
      expect(deleteStateMachine).toContain("MarkFailed");
    });

    it("EventBridge Rule を Create / Delete / BulkCreate / GenericScoring / ExternalIdAudit schedule で 5 つ持つべき (Issue #910 Phase 2.C.2.a)", () => {
      // 旧 2 (Create / Delete state-machine event rules)
      //   + BulkCreate (Issue #910 Phase 2.C: BulkDeployCreateRequested → Distributed Map)
      //   + GenericScoring schedule rate(1 minute) (= ADR-012 Phase 3.B、 旧 HealthCheck 後継)
      //   + ExternalIdAudit schedule rate(1 day) (= Phase 3.2 / Issue #603 で追加)
      // = 5。GenericScoring は scoring 問題が無い tenant でも reconcile 用に常時 instantiate される。
      tpl.resourceCountIs("AWS::Events::Rule", 5);
      tpl.hasResourceProperties(
        "AWS::Events::Rule",
        Match.objectLike({
          EventPattern: Match.objectLike({
            source: ["tenkacloud.deploy"],
            "detail-type": ["DeployCreateRequested"],
          }),
        }),
      );
      tpl.hasResourceProperties(
        "AWS::Events::Rule",
        Match.objectLike({
          EventPattern: Match.objectLike({
            source: ["tenkacloud.deploy"],
            "detail-type": ["DeployDeleteRequested"],
          }),
        }),
      );
      // GenericScoring の rate(1 minute) schedule (= ADR-012 Phase 3.B dispatcher + reconciler)
      tpl.hasResourceProperties(
        "AWS::Events::Rule",
        Match.objectLike({
          ScheduleExpression: "rate(1 minute)",
        }),
      );
      // ExternalIdAudit の rate(1 day) schedule (Phase 3.2 / Issue #603)
      tpl.hasResourceProperties(
        "AWS::Events::Rule",
        Match.objectLike({
          ScheduleExpression: "rate(1 day)",
        }),
      );
    });

    it("GenericScoring Lambda が PROBLEM_ENDPOINTS_TABLE_NAME / BATTLE_PROBLEMS_PHASES env を持つべき", () => {
      // ADR-012 Phase 3.B: 旧 HealthCheck Lambda は scoring 設定のみ持っていたが、
      // GenericScoring は Endpoint registry (Phase 3.A) と Phase 定義 (Phase 3.B) を併せて受ける。
      tpl.hasResourceProperties(
        "AWS::Lambda::Function",
        Match.objectLike({
          Runtime: "nodejs22.x",
          Architectures: ["arm64"],
          Environment: Match.objectLike({
            Variables: Match.objectLike({
              DEPLOYMENTS_TABLE_NAME: Match.anyValue(),
              EVENTS_TABLE_NAME: Match.anyValue(),
              PROBLEM_ENDPOINTS_TABLE_NAME: Match.anyValue(),
              BATTLE_PROBLEMS_SCORING: Match.anyValue(),
              PROBLEM_ENDPOINTS: Match.anyValue(),
              BATTLE_PROBLEMS_PHASES: Match.anyValue(),
            }),
          }),
        }),
      );
    });
  });

  describe("Outputs", () => {
    it("DeploymentsTableName と DeployCreateStateMachineArn を Output として持つべき", () => {
      const outputs = tpl.findOutputs("*");
      expect(Object.keys(outputs)).toEqual(
        expect.arrayContaining(["DeploymentsTableName", "DeployCreateStateMachineArn"]),
      );
    });

    it("ADR-012 Phase 3.A: ProblemEndpointsTableName を Output として持つべき", () => {
      const outputs = tpl.findOutputs("*");
      expect(Object.keys(outputs)).toEqual(expect.arrayContaining(["ProblemEndpointsTableName"]));
    });
  });

  describe("legacy 経路の廃止", () => {
    it("旧 DeployApiGateway (HTTP API) を作らないべき", () => {
      tpl.resourceCountIs("AWS::ApiGatewayV2::Api", 0);
    });
  });

  describe("Competitor Accounts API Lambda (Issue #459 / ADR-002 Phase 2.1)", () => {
    it("Lambda が COMPETITOR_ACCOUNTS_TABLE_NAME / DEPLOY_ENVIRONMENT / TENKACLOUD_ACCOUNT_ID env を持つべき", () => {
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

    it("Lambda Role に SSM Parameter Store + STS AssumeRole の最小権限を付与するべき", () => {
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

    it("Output に CompetitorAccountsTableName を含むべき", () => {
      const outputs = tpl.findOutputs("*");
      expect(Object.keys(outputs)).toEqual(expect.arrayContaining(["CompetitorAccountsTableName"]));
    });

    it("Phase 3.2 / Issue #603: ExternalIdAudit Lambda が rate(1 day) で起動し PutMetricData (namespace 絞り込み) を持つべき", () => {
      // rate(1 day) schedule は上の resourceCountIs(Rule, 4) の test でも assert 済だが、ここでは
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

    it("KMS policy は StringLike + Decrypt/GenerateDataKey を持つべき (= SSM SecureString GET/PUT 双方を動かす)", () => {
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
});

/**
 * ParticipantPortalLambda 単体 synth (#535 再発防止)。
 *
 * Stack 全体を synth すると `ParticipantPortalHosting` が
 * `apps/participant-portal/dist` の asset を要求し、CI 環境 (= dist 未 build) で
 * fail する。Lambda の env / IAM だけ確認できれば十分なので、Lambda construct を
 * 単体で synth する。
 */
function synthParticipantPortalLambdaOnly(): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "TestStack");
  const deployments = new cdk.aws_dynamodb.Table(stack, "Deployments", {
    partitionKey: { name: "PK", type: cdk.aws_dynamodb.AttributeType.STRING },
    sortKey: { name: "SK", type: cdk.aws_dynamodb.AttributeType.STRING },
  });
  const events = new cdk.aws_dynamodb.Table(stack, "Events", {
    partitionKey: { name: "PK", type: cdk.aws_dynamodb.AttributeType.STRING },
    sortKey: { name: "SK", type: cdk.aws_dynamodb.AttributeType.STRING },
  });
  const endpoints = new cdk.aws_dynamodb.Table(stack, "ProblemEndpoints", {
    partitionKey: { name: "PK", type: cdk.aws_dynamodb.AttributeType.STRING },
    sortKey: { name: "SK", type: cdk.aws_dynamodb.AttributeType.STRING },
  });
  new ParticipantPortalLambda(stack, "ParticipantPortal", {
    deploymentsTable: deployments,
    eventsTable: events,
    endpointsTable: endpoints,
    problemsScoring: {},
    problemsEndpoints: {},
    environmentName: "development",
  });
  return Template.fromStack(stack);
}

describe("ParticipantPortalLambda wiring (#535)", () => {
  const tpl = synthParticipantPortalLambdaOnly();

  it("ParticipantPortal Lambda の environment に EVENTS_TABLE_NAME が設定されるべき", () => {
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

  it("ParticipantPortal Lambda の IAM Role に Events table の dynamodb:Query を付与するべき", () => {
    // ADR-006: GET /portal/me/notifications が Events table を Query する。
    // 配線が無いと AccessDenied で 500 になる。Role 直貼りの inline policy なので
    // `AWS::IAM::Role` の Policies 配列を見る。
    tpl.hasResourceProperties(
      "AWS::IAM::Role",
      Match.objectLike({
        Policies: Match.arrayWith([
          Match.objectLike({
            PolicyName: "EventsRead",
            PolicyDocument: Match.objectLike({
              Statement: Match.arrayWith([
                Match.objectLike({
                  Action: "dynamodb:Query",
                  Effect: "Allow",
                }),
              ]),
            }),
          }),
        ]),
      }),
    );
  });

  it("ADR-012 Phase 3.A: environment に PROBLEM_ENDPOINTS_TABLE_NAME + PROBLEM_ENDPOINTS を持つべき", () => {
    tpl.hasResourceProperties(
      "AWS::Lambda::Function",
      Match.objectLike({
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            PROBLEM_ENDPOINTS_TABLE_NAME: Match.anyValue(),
            PROBLEM_ENDPOINTS: Match.anyValue(),
          }),
        }),
      }),
    );
  });

  it("AWS Console SSO 用に DEPLOY_ENVIRONMENT を持つべき", () => {
    const functions = tpl.findResources("AWS::Lambda::Function");
    const fn = Object.values(functions)[0] as {
      Properties?: { Environment?: { Variables?: Record<string, unknown> } };
    };
    const vars = fn.Properties?.Environment?.Variables ?? {};
    expect(vars.DEPLOY_ENVIRONMENT).toBe("development");
  });

  it("AWS Console SSO 用に SSM ExternalId read と CompetitorDeployRole AssumeRole 権限を持つべき", () => {
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

  it("ADR-012 Phase 3.A: IAM Role に Endpoints table の Query / PutItem / DeleteItem 権限を付与するべき", () => {
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
});

describe("ProblemDeployBackendStack (#778 ADR-016 Phase 2: eventBusArn optional 化)", () => {
  // synth は 5 個の NodejsFunction (= esbuild bundling) を含むため CI 上で ~7s かかる。
  // vitest の default 5s timeout を 30s に拡張する (= 既存 #538 test と同じ pattern)。
  const SYNTH_TIMEOUT_MS = 30_000;

  // describe scope で 1 度だけ synth して、 3 件の it で再利用 (= per-test の重複 synth で
  // 21s 消費するのを 7s に圧縮)。
  let liteTemplate: Template;
  let fullTemplate: Template;

  it(
    "eventBusArn を省略すると local EventBus を 1 つ新規に作るべき (= Lite mode の自己完結)",
    () => {
      const app = new cdk.App();
      const stack = new ProblemDeployBackendStack(app, "LiteStack", {
        sourceBucketName: "test-source-bucket-lite",
        sourceObjectKey: "source.zip",
        problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
        problemsScoring: {},
        problemsEndpoints: {},
        environmentName: "development",
        // eventBusArn を省略 (= Lite mode)
      });
      liteTemplate = Template.fromStack(stack);
      liteTemplate.resourceCountIs("AWS::Events::EventBus", 1);
      liteTemplate.hasResourceProperties(
        "AWS::Events::EventBus",
        Match.objectLike({
          Name: Match.stringLikeRegexp("^tenkacloud-problem-deploy-local-"),
        }),
      );
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "eventBusArn を渡した既存 (= Full mode) では local EventBus を作らないべき",
    () => {
      fullTemplate = synthDefault();
      fullTemplate.resourceCountIs("AWS::Events::EventBus", 0);
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    "eventBusArn 省略でも DeployApi / EventApi / CompetitorAccountsApi / GenericScoring Lambda は同じ構成で生えるべき (= 機能 dormant にならない)",
    () => {
      // 前の test で立てた liteTemplate を再利用 (= synth コストを節約)。
      if (!liteTemplate) {
        const app = new cdk.App();
        const stack = new ProblemDeployBackendStack(app, "LiteStack2", {
          sourceBucketName: "test-source-bucket-lite-2",
          sourceObjectKey: "source.zip",
          problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
          problemsScoring: {},
          problemsEndpoints: {},
          environmentName: "development",
        });
        liteTemplate = Template.fromStack(stack);
      }
      const lambdaCount = Object.keys(liteTemplate.findResources("AWS::Lambda::Function")).length;
      expect(lambdaCount).toBeGreaterThan(0);
      // EventBridge Rule (= Step Functions trigger) も local bus にぶら下がる。
      const ruleCount = Object.keys(liteTemplate.findResources("AWS::Events::Rule")).length;
      expect(ruleCount).toBeGreaterThan(0);
    },
    SYNTH_TIMEOUT_MS,
  );
});
