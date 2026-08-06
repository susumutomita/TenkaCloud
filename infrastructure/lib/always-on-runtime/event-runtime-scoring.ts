import * as path from "node:path";
import { Duration, Stack } from "aws-cdk-lib";
import { Table } from "aws-cdk-lib/aws-dynamodb";
import { EventBus, Rule, RuleTargetInput, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { defineNodejsFunction } from "../utils/define-nodejs-function.js";

export interface EventRuntimeScoringProps {
  readonly eventId: string;
  readonly deploymentsTableName: string;
  readonly eventsTableName: string;
  readonly endpointsTableName: string;
  readonly disruptionsTableName?: string;
  readonly eventBusName?: string;
  readonly runtimeFeedTokenParameterName: string;
  readonly controlPlaneUrl: string;
  readonly problemsScoring: Readonly<Record<string, unknown>>;
  readonly problemsEndpoints: Readonly<Record<string, unknown>>;
  readonly problemsPhases: Readonly<Record<string, unknown>>;
  readonly problemsDisruptions: Readonly<Record<string, unknown>>;
}

/**
 * Per-event Battle scoring tick for Always-On mode.
 *
 * The EventBridge rule and Lambda live in the event runtime stack, so neither exists between
 * events. The invocation payload carries the immutable event scope; the handler skips the
 * control-plane reconciliation that Workers Cron owns and publishes only the materialized team
 * scores back to the Worker.
 */
export class EventRuntimeScoring extends Construct {
  public readonly fn: NodejsFunction;
  public readonly schedule: Rule;

  constructor(scope: Construct, id: string, props: EventRuntimeScoringProps) {
    super(scope, id);
    const deploymentsTable = Table.fromTableName(
      this,
      "DeploymentsTable",
      props.deploymentsTableName,
    );
    const eventsTable = Table.fromTableName(this, "EventsTable", props.eventsTableName);
    const endpointsTable = Table.fromTableName(this, "EndpointsTable", props.endpointsTableName);
    const disruptionsTable = props.disruptionsTableName
      ? Table.fromTableName(this, "DisruptionsTable", props.disruptionsTableName)
      : undefined;
    const eventBus = props.eventBusName
      ? EventBus.fromEventBusName(this, "EventBus", props.eventBusName)
      : undefined;
    const runtimeFeedTokenParameter = StringParameter.fromStringParameterName(
      this,
      "RuntimeFeedToken",
      props.runtimeFeedTokenParameterName,
    );

    this.fn = defineNodejsFunction(this, {
      entry: path.resolve(
        import.meta.dirname,
        "../problem-deploy/handlers/generic-scoring-handler/index.ts",
      ),
      timeout: Duration.minutes(2),
      memorySize: 1024,
      reservedConcurrentExecutions: 1,
      environment: {
        DEPLOYMENTS_TABLE_NAME: deploymentsTable.tableName,
        EVENTS_TABLE_NAME: eventsTable.tableName,
        PROBLEM_ENDPOINTS_TABLE_NAME: endpointsTable.tableName,
        DISRUPTIONS_TABLE_NAME: disruptionsTable?.tableName ?? "",
        DEPLOY_EVENT_BUS_NAME: eventBus?.eventBusName ?? "",
        ALWAYS_ON_CONTROL_PLANE_URL: props.controlPlaneUrl,
        RUNTIME_FEED_TOKEN_PARAMETER_NAME: runtimeFeedTokenParameter.parameterName,
        NODE_OPTIONS: "--enable-source-maps",
      },
      // BATTLE_PROBLEMS_SCORING は実測 130 KiB で argv の 1 引数上限を跨いだ (#2891)。
      bundledData: {
        BATTLE_PROBLEMS_SCORING: JSON.stringify(props.problemsScoring),
      },
      bundlingDefine: {
        "process.env.PROBLEM_ENDPOINTS": JSON.stringify(JSON.stringify(props.problemsEndpoints)),
        "process.env.BATTLE_PROBLEMS_PHASES": JSON.stringify(JSON.stringify(props.problemsPhases)),
        "process.env.BATTLE_PROBLEMS_DISRUPTIONS": JSON.stringify(
          JSON.stringify(props.problemsDisruptions),
        ),
        // Coordination execution remains a separately scoped runtime capability.
        "process.env.PROBLEM_COORDINATION": JSON.stringify("{}"),
      },
    });

    deploymentsTable.grantReadWriteData(this.fn);
    eventsTable.grantReadData(this.fn);
    endpointsTable.grantReadData(this.fn);
    disruptionsTable?.grantReadData(this.fn);
    eventBus?.grantPutEventsTo(this.fn);
    runtimeFeedTokenParameter.grantRead(this.fn);
    this.fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["kms:Decrypt"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "kms:EncryptionContext:PARAMETER_ARN": Stack.of(this).formatArn({
              service: "ssm",
              resource: "parameter",
              resourceName: props.runtimeFeedTokenParameterName.replace(/^\/+/u, ""),
            }),
          },
        },
      }),
    );
    // The scoring update is not replay-safe. A failed invocation is repaired by the next
    // one-minute authoritative tick; Lambda must not retry a partially committed invocation.
    this.fn.configureAsyncInvoke({
      retryAttempts: 0,
      maxEventAge: Duration.minutes(2),
    });

    this.schedule = new Rule(this, "Schedule", {
      schedule: Schedule.rate(Duration.minutes(1)),
      description: `TenkaCloud Always-On Battle scoring tick for event ${props.eventId}.`,
      targets: [
        new LambdaFunction(this.fn, {
          event: RuleTargetInput.fromObject({ eventId: props.eventId }),
        }),
      ],
    });
  }
}
