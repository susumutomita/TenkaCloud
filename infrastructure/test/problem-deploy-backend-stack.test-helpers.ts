import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Project } from "aws-cdk-lib/aws-codebuild";
import { CoordinationDispatcherLambda } from "../lib/problem-deploy/coordination-dispatcher-lambda";
import { ParticipantPortalLambda } from "../lib/problem-deploy/participant-portal-lambda";
import { ProblemDeployBackendStack } from "../lib/problem-deploy/problem-deploy-backend-stack";

// synth は 5 個の NodejsFunction (= esbuild bundling) を含むため CI 上で ~7s かかる。
// vitest の default 5s timeout を拡張する (= 既存 #538 test と同じ pattern)。
// Issue #1249: 旧 problem-deploy-backend-stack.test.ts (781 行) を resource type 別 6 ファイル
// + helper に分割した際の共有 timeout (各 file が自前で synth するため timeout が必要)。
// 全 suite 並列時は fork 飽和で 36MB asset の esbuild bundling 単体が 25s+ かかり 30s を
// 超えることがあるため 120s (= 分離実行 ~7s に対する安全マージン、hang 検出は維持)。
export const SYNTH_TIMEOUT_MS = 120_000;

// 全 it() で同じ Template を使い回す。stack 構造は default props で固定なので、
// describe ブロック単位で 1 度 synth すれば再利用できる。
// Issue #1249: ファイル分割後、複数の test file が同じ default Template を読むので、
// helper module scope でメモ化することで synth コストの増加を防ぐ (元 file と同じ 2 synth)。
let cachedDefault: Template | undefined;
export function synthDefault(): Template {
  if (cachedDefault) return cachedDefault;
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
  cachedDefault = Template.fromStack(stack);
  return cachedDefault;
}

// Issue #2232: useBulkDistributedMap: true を反映させた EventApi Lambda env を検証するための
// 別 synth (= 既存 synthWithDeployConcurrentBuildLimit と同じ pattern)。
export function synthWithBulkDistributedMap(): Template {
  const app = new cdk.App();
  const stack = new ProblemDeployBackendStack(app, "TestStackWithDistributedMap", {
    eventBusArn: "arn:aws:events:ap-northeast-1:123456789012:event-bus/test-bus",
    sourceBucketName: "test-source-bucket",
    sourceObjectKey: "source.zip",
    problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
    problemsScoring: {},
    problemsEndpoints: {},
    useBulkDistributedMap: true,
    environmentName: "development",
  });
  return Template.fromStack(stack);
}

// Issue #2311: auditLogEnabled: false を反映させ、 監査を書く Lambda 群の env に
// AUDIT_LOG_ENABLED="false" が注入されることを検証するための別 synth。
export function synthWithAuditLogDisabled(): Template {
  const app = new cdk.App();
  const stack = new ProblemDeployBackendStack(app, "TestStackAuditDisabled", {
    eventBusArn: "arn:aws:events:ap-northeast-1:123456789012:event-bus/test-bus",
    sourceBucketName: "test-source-bucket",
    sourceObjectKey: "source.zip",
    problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
    problemsScoring: {},
    problemsEndpoints: {},
    auditLogEnabled: false,
    environmentName: "development",
  });
  return Template.fromStack(stack);
}

// Issue #2290: controlDataBackend: "turso" を反映させ、監査 Lambda 群の env に
// CONTROL_DATA_BACKEND="turso" が注入されることを検証するための別 synth (= synthWithAuditLogDisabled
// と同じ pattern)。
export function synthWithControlDataBackendTurso(): Template {
  const app = new cdk.App();
  const stack = new ProblemDeployBackendStack(app, "TestStackControlDataTurso", {
    eventBusArn: "arn:aws:events:ap-northeast-1:123456789012:event-bus/test-bus",
    sourceBucketName: "test-source-bucket",
    sourceObjectKey: "source.zip",
    problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
    problemsScoring: {},
    problemsEndpoints: {},
    controlDataBackend: "turso",
    environmentName: "development",
  });
  return Template.fromStack(stack);
}

// #538: deployConcurrentBuildLimit を反映させた CodeBuild Project を検証するための別 synth。
export function synthWithDeployConcurrentBuildLimit(): Template {
  const app = new cdk.App();
  const stack = new ProblemDeployBackendStack(app, "TestStackWithLimit", {
    eventBusArn: "arn:aws:events:ap-northeast-1:123456789012:event-bus/test-bus",
    sourceBucketName: "test-source-bucket",
    sourceObjectKey: "source.zip",
    problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
    problemsScoring: {},
    problemsEndpoints: {},
    deployConcurrentBuildLimit: 200,
    // #1766: tier 別同時デプロイ上限の env 配線検証用。
    deployQuotaByTier: { basic: 2, advanced: 5, platinum: 10 },
    environmentName: "development",
  });
  return Template.fromStack(stack);
}

// #778 ADR-016 Phase 2: eventBusArn を省略した Lite mode の synth。 別 stackId / bucket name を渡す。
export function synthLite(stackId: string, sourceBucketName: string): Template {
  const app = new cdk.App();
  const stack = new ProblemDeployBackendStack(app, stackId, {
    sourceBucketName,
    sourceObjectKey: "source.zip",
    problemsCatalog: { "hello-world": "problems/challenges/hello-world" },
    problemsScoring: {},
    problemsEndpoints: {},
    environmentName: "development",
    // eventBusArn を省略 (= Lite mode)
  });
  return Template.fromStack(stack);
}

/**
 * ParticipantPortalLambda 単体 synth (#535 再発防止)。
 *
 * Stack 全体を synth すると `ParticipantPortalHosting` が
 * `apps/participant-portal/dist` の asset を要求し、CI 環境 (= dist 未 build) で
 * fail する。Lambda の env / IAM だけ確認できれば十分なので、Lambda construct を
 * 単体で synth する。
 */
export function synthParticipantPortalLambdaOnly(): Template {
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
    // deploy-logs streaming grant の対象 (= codebuild:BatchGetBuilds / logs:GetLogEvents scope)。
    deployCodeBuildProject: Project.fromProjectName(stack, "DeployCodeBuild", "tc-deploy-project"),
  });
  return Template.fromStack(stack);
}

/**
 * ADR-030 Phase 2 (#1420): CoordinationDispatcherLambda 単体 synth。 stack 全体 synth は
 * ParticipantPortalHosting の dist asset を要求するため、 IAM (最小権限) / Function URL の検証は
 * construct 単体で行う (= synthParticipantPortalLambdaOnly と同方針)。
 */
export function synthCoordinationDispatcherLambdaOnly(): Template {
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
  new CoordinationDispatcherLambda(stack, "CoordinationDispatcher", {
    deploymentsTable: deployments,
    eventsTable: events,
    environmentName: "development",
  });
  return Template.fromStack(stack);
}
