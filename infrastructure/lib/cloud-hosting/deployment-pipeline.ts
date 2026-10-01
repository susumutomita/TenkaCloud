import { join } from "node:path";
import { ArnFormat, Duration, Stack } from "aws-cdk-lib";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { IBucket } from "aws-cdk-lib/aws-s3";
import {
  Choice,
  Condition,
  DefinitionBody,
  Fail,
  JsonPath,
  LogLevel,
  Pass,
  Result,
  StateMachine,
  StateMachineType,
  Succeed,
  TaskInput,
  Wait,
  WaitTime,
} from "aws-cdk-lib/aws-stepfunctions";
import { LambdaInvoke } from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";
import type { InstallationCompetitorConfig } from "../problem-deploy/control-data/domain/competitor-accounts.js";
import type { RunnerBinding } from "../problem-deploy/handlers/cloud-api/execution-config.js";
import { competitorAssumeRolePolicy, denyControlPlaneAssumeRole } from "./competitor-accounts.js";

export interface CloudDeploymentPipelineProps {
  readonly repositoryRoot: string;
  readonly workflowEntry?: string;
  readonly dispatcherEntry?: string;
  readonly events: ITable;
  readonly teams: ITable;
  readonly deployments: ITable;
  readonly allowedRoleArns: readonly string[];
  readonly runnerBindings: readonly RunnerBinding[];
  readonly externalIdParameterArns: readonly string[];
  readonly externalIdKmsKeyArns?: readonly string[];
  readonly catalogBucket: IBucket;
  readonly catalogKey: string;
  readonly bindingsKey: string;
  readonly competitorConfig?: InstallationCompetitorConfig;
}

/** Registry-backed runner with installation-scoped roles; old exact bindings remain explicit compatibility grants. */
export class CloudDeploymentPipeline extends Construct {
  readonly stateMachine: StateMachine;
  readonly dispatcher: NodejsFunction;
  readonly workers: Readonly<
    Record<"claim" | "create" | "describe" | "finish" | "fail", NodejsFunction>
  >;
  constructor(scope: Construct, id: string, props: CloudDeploymentPipelineProps) {
    super(scope, id);
    validateAllowlist(props);
    const environment = {
      CONTROL_PLANE_ACCOUNT: Stack.of(this).account,
      EVENTS_TABLE_NAME: props.events.tableName,
      TEAMS_TABLE_NAME: props.teams.tableName,
      DEPLOYMENTS_TABLE_NAME: props.deployments.tableName,
      CLOUD_ARTIFACT_BUCKET: props.catalogBucket.bucketName,
      CLOUD_CATALOG_KEY: props.catalogKey,
      CLOUD_RUNNER_BINDINGS_KEY: props.bindingsKey,
      ...(props.competitorConfig
        ? {
            COMPETITOR_ROLE_NAME: props.competitorConfig.roleName,
            COMPETITOR_EXTERNAL_ID_PARAMETER_ARN: props.competitorConfig.externalIdParameterArn,
          }
        : {}),
    };
    const makeWorker = (
      name: string,
      entry: string,
      handler: string,
      timeout = 60,
      reservedConcurrentExecutions?: number,
    ) => {
      const logs = new LogGroup(this, `${name}Logs`, { retention: RetentionDays.ONE_WEEK });
      const role = new Role(this, `${name}Role`, {
        assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      });
      logs.grantWrite(role);
      return new NodejsFunction(this, name, {
        entry,
        handler,
        role,
        logGroup: logs,
        runtime: Runtime.NODEJS_24_X,
        timeout: Duration.seconds(timeout),
        memorySize: 512,
        reservedConcurrentExecutions,
        depsLockFilePath: join(props.repositoryRoot, "bun.lock"),
        projectRoot: props.repositoryRoot,
        bundling: { bundleAwsSDK: true, minify: true, target: "node24" },
        environment,
      });
    };
    const entry =
      props.workflowEntry ??
      join(
        props.repositoryRoot,
        "infrastructure/lib/problem-deploy/handlers/cloud-runner/lambda.ts",
      );
    const workers = {
      claim: makeWorker("Claim", entry, "claimHandler"),
      create: makeWorker("Create", entry, "createHandler"),
      describe: makeWorker("Describe", entry, "describeHandler"),
      finish: makeWorker("Finish", entry, "finishHandler"),
      fail: makeWorker("Fail", entry, "failHandler"),
    };
    this.workers = workers;
    for (const worker of Object.values(workers)) {
      grant(worker, ["dynamodb:GetItem"], [props.deployments.tableArn]);
      grant(worker, ["s3:GetObject"], [props.catalogBucket.arnForObjects(props.bindingsKey)]);
    }
    for (const worker of [workers.claim, workers.create, workers.describe, workers.finish]) {
      grant(worker, ["dynamodb:GetItem"], [props.events.tableArn]);
    }
    grant(
      workers.claim,
      ["dynamodb:UpdateItem", "dynamodb:DeleteItem"],
      [props.deployments.tableArn],
    );
    grant(workers.claim, ["dynamodb:ConditionCheckItem"], [props.events.tableArn]);
    for (const worker of [workers.create, workers.finish, workers.fail])
      grant(worker, ["dynamodb:PutItem", "dynamodb:UpdateItem"], [props.deployments.tableArn]);
    grant(workers.describe, ["dynamodb:UpdateItem"], [props.deployments.tableArn]);
    grant(workers.fail, ["dynamodb:DeleteItem"], [props.deployments.tableArn]);
    for (const worker of [workers.create, workers.describe, workers.finish])
      grant(
        worker,
        ["dynamodb:ConditionCheckItem"],
        [props.events.tableArn, props.deployments.tableArn],
      );
    grant(workers.finish, ["dynamodb:UpdateItem"], [props.events.tableArn]);
    workers.finish.addToRolePolicy(
      new PolicyStatement({
        actions: ["dynamodb:DeleteItem"],
        resources: [props.deployments.tableArn],
        conditions: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["DISPATCH#PENDING"] },
        },
      }),
    );
    for (const worker of [workers.create, workers.describe, workers.finish])
      worker.addToRolePolicy(
        new PolicyStatement({
          actions: ["dynamodb:Query"],
          resources: [props.deployments.tableArn],
          conditions: {
            "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPLOYMENT#*"] },
          },
        }),
      );
    for (const worker of [workers.create, workers.describe, workers.finish]) {
      grantCompetitorAccess(worker, props);
      // Old pending jobs retain their immutable catalog key across application updates. The
      // loader permits only catalogs/<sha256>.json and verifies the content hash before use.
      grant(worker, ["s3:GetObject"], [props.catalogBucket.arnForObjects("catalogs/*")]);
      if (props.externalIdKmsKeyArns?.length)
        grant(worker, ["kms:Decrypt"], [...props.externalIdKmsKeyArns]);
    }
    const invoke = (name: string, worker: NodejsFunction, payload?: TaskInput) => {
      const task = new LambdaInvoke(this, name, {
        lambdaFunction: worker,
        payloadResponseOnly: true,
        payload: payload ?? TaskInput.fromJsonPathAt("$"),
        retryOnServiceExceptions: false,
      });
      task.addRetry({
        errors: [
          "Lambda.ServiceException",
          "Lambda.AWSLambdaException",
          "Lambda.SdkClientException",
          "Lambda.TooManyRequestsException",
          "CloudWorkflowError",
        ],
        interval: Duration.seconds(2),
        backoffRate: 2,
        maxAttempts: 2,
      });
      return task;
    };
    const failureEnd = new Fail(this, "DeploymentFailed", {
      error: "CloudDeploymentFailed",
      cause: "See the owned deployment record for the bounded failure code",
    });
    const success = new Succeed(this, "DeploymentComplete");
    const failureSave = invoke("PersistFailure", workers.fail).next(failureEnd);
    // Catch discards raw Error/Cause, then records a fixed safe code while preserving reference.
    const workerFailure = new Pass(this, "WorkerFailure", {
      result: Result.fromString("worker_failed"),
      resultPath: "$.failureCode",
    }).next(failureSave);
    const exhausted = new Pass(this, "PollLimitExceeded", {
      result: Result.fromString("poll_limit_exceeded"),
      resultPath: "$.failureCode",
    }).next(failureSave);
    const claim = invoke("ClaimDeployment", workers.claim);
    const create = invoke("CreateDeployment", workers.create);
    const describe = invoke("DescribeDeployment", workers.describe);
    const finish = invoke("FinishDeployment", workers.finish);
    const finishResult = new Choice(this, "FinishedSuccessfully")
      .when(Condition.stringEquals("$.phase", "ready"), success)
      .otherwise(failureEnd);
    finish.next(finishResult);
    const wait = new Wait(this, "WaitForStack", { time: WaitTime.duration(Duration.seconds(30)) });
    const route = new Choice(this, "StackTerminal")
      .when(Condition.stringEquals("$.phase", "ready"), finish)
      .when(Condition.stringEquals("$.phase", "failed"), finish)
      .when(Condition.numberGreaterThanEquals("$.pollCount", 120), exhausted)
      .otherwise(wait);
    for (const task of [claim, create, describe, finish])
      task.addCatch(workerFailure, { resultPath: JsonPath.DISCARD });
    wait.next(describe).next(route);
    const initialize = new Pass(this, "BindExecutionOwner", {
      parameters: {
        "identity.$": "$.identity",
        "owner.$": "$$.Execution.Id",
        phase: "pending",
        pollCount: 0,
      },
    });
    initialize.next(claim).next(create).next(route);
    const logs = new LogGroup(this, "WorkflowLogs", { retention: RetentionDays.ONE_WEEK });
    this.stateMachine = new StateMachine(this, "DeploymentWorkflow", {
      stateMachineType: StateMachineType.STANDARD,
      definitionBody: DefinitionBody.fromChainable(initialize),
      timeout: Duration.minutes(90),
      logs: { destination: logs, level: LogLevel.ERROR, includeExecutionData: false },
    });
    this.dispatcher = makeWorker(
      "Dispatcher",
      props.dispatcherEntry ??
        join(
          props.repositoryRoot,
          "infrastructure/lib/problem-deploy/handlers/cloud-runner/dispatcher.ts",
        ),
      "handler",
      120,
      1,
    );
    this.dispatcher.addToRolePolicy(
      new PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [props.events.tableArn],
        conditions: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["INSTALLATION"] },
        },
      }),
    );
    this.dispatcher.addEnvironment(
      "DEPLOYMENT_STATE_MACHINE_ARN",
      this.stateMachine.stateMachineArn,
    );
    this.dispatcher.addToRolePolicy(
      new PolicyStatement({
        actions: ["dynamodb:Query"],
        resources: [props.deployments.tableArn],
        conditions: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["DISPATCH#PENDING"] },
        },
      }),
    );
    grant(this.dispatcher, ["states:StartExecution"], [this.stateMachine.stateMachineArn]);
    this.dispatcher.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
        ],
        resources: [props.deployments.tableArn],
        conditions: {
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": ["DEPLOYMENT#*", "DISPATCH#PENDING"],
          },
        },
      }),
    );
    grant(
      this.dispatcher,
      ["states:DescribeExecution"],
      [
        Stack.of(this).formatArn({
          service: "states",
          resource: "execution",
          resourceName: `${this.stateMachine.stateMachineName}:*`,
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
    );
    new Rule(this, "DispatchEveryMinute", {
      schedule: Schedule.rate(Duration.minutes(1)),
      targets: [
        new LambdaFunction(this.dispatcher, { retryAttempts: 2, maxEventAge: Duration.minutes(5) }),
      ],
    });
    const recovery = makeWorker(
      "Recovery",
      props.dispatcherEntry ??
        join(
          props.repositoryRoot,
          "infrastructure/lib/problem-deploy/handlers/cloud-runner/dispatcher.ts",
        ),
      "recoveryHandler",
    );
    recovery.addEnvironment("DEPLOYMENT_STATE_MACHINE_ARN", this.stateMachine.stateMachineArn);
    grant(
      recovery,
      ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
      [props.deployments.tableArn],
    );
    grant(
      recovery,
      ["states:DescribeExecution"],
      [
        Stack.of(this).formatArn({
          service: "states",
          resource: "execution",
          resourceName: `${this.stateMachine.stateMachineName}:*`,
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
    );
    new Rule(this, "RecoverTerminalExecution", {
      eventPattern: {
        source: ["aws.states"],
        detailType: ["Step Functions Execution Status Change"],
        detail: {
          stateMachineArn: [this.stateMachine.stateMachineArn],
          status: ["FAILED", "TIMED_OUT", "ABORTED"],
        },
      },
      targets: [
        new LambdaFunction(recovery, { retryAttempts: 185, maxEventAge: Duration.hours(24) }),
      ],
    });
  }
}

function grantCompetitorAccess(worker: NodejsFunction, props: CloudDeploymentPipelineProps) {
  worker.addToRolePolicy(denyControlPlaneAssumeRole(Stack.of(worker).account));
  if (props.allowedRoleArns.length) grant(worker, ["sts:AssumeRole"], [...props.allowedRoleArns]);
  if (props.externalIdParameterArns.length)
    grant(worker, ["ssm:GetParameter"], [...props.externalIdParameterArns]);
  if (props.competitorConfig) {
    worker.addToRolePolicy(competitorAssumeRolePolicy(props.competitorConfig));
    grant(worker, ["ssm:GetParameter"], [props.competitorConfig.externalIdParameterArn]);
  }
}

function grant(worker: NodejsFunction, actions: string[], resources: string[]) {
  worker.addToRolePolicy(new PolicyStatement({ actions, resources }));
}
function validateAllowlist(props: CloudDeploymentPipelineProps): void {
  if (
    (!props.competitorConfig && !props.runnerBindings.length) ||
    props.runnerBindings.some(
      (binding) =>
        !props.allowedRoleArns.includes(binding.roleArn) ||
        !props.externalIdParameterArns.includes(binding.externalIdParameterArn),
    ) ||
    (!props.competitorConfig && !props.allowedRoleArns.length) ||
    (!props.competitorConfig && !props.externalIdParameterArns.length) ||
    props.allowedRoleArns.some((arn) => !/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/u.test(arn)) ||
    props.externalIdParameterArns.some(
      (arn) => !/^arn:aws:ssm:[a-z0-9-]+:\d{12}:parameter\/[\w./-]+$/u.test(arn),
    ) ||
    !props.catalogKey ||
    props.catalogKey.includes("*") ||
    props.catalogKey.includes("?") ||
    !/^bindings\/[a-f0-9]{64}\.json$/u.test(props.bindingsKey) ||
    props.externalIdKmsKeyArns?.some(
      (arn) => !/^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[a-zA-Z0-9-]+$/u.test(arn),
    )
  ) {
    throw new Error("Deployment runner requires exact role, ExternalId and artifact allowlists");
  }
}
