import * as path from "node:path";
import { Duration } from "aws-cdk-lib";
import type { IEventBus } from "aws-cdk-lib/aws-events";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction as LambdaTarget } from "aws-cdk-lib/aws-events-targets";
import type { IRole } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import { COMPETITOR_ROLE_NAME_DEFAULT } from "./handlers/shared/events";

export interface StatusUpdaterLambdaProps {
  readonly deploymentsTableName: string;
  readonly eventBus: IEventBus;
  readonly executionRole: IRole;
  readonly externalId: string;
  readonly competitorRoleName?: string;
  /**
   * 起動間隔。EventBridge classic Rule は分単位までしか扱えないため default は 1 分。
   * (秒単位 polling が要るなら EventBridge Scheduler に置き換える)
   */
  readonly schedulePeriod?: Duration;
}

/**
 * 30 秒ごとに走り、IN_PROGRESS な deployment の CFn StackStatus を polling して DDB と
 * EventBus に反映する Lambda。expiresAt を超えた non-terminal deployment は DeleteStack
 * で auto teardown する。
 */
export class StatusUpdaterLambda extends Construct {
  public readonly fn: NodejsFunction;
  public readonly rule: Rule;

  constructor(scope: Construct, id: string, props: StatusUpdaterLambdaProps) {
    super(scope, id);

    this.fn = new NodejsFunction(this, "Function", {
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      entry: path.resolve(__dirname, "handlers/status-updater/index.ts"),
      handler: "handler",
      timeout: Duration.minutes(5),
      memorySize: 512,
      role: props.executionRole,
      environment: {
        DEPLOYMENTS_TABLE_NAME: props.deploymentsTableName,
        DEPLOY_EVENT_BUS_NAME: props.eventBus.eventBusName,
        DEPLOY_EXTERNAL_ID: props.externalId,
        COMPETITOR_ROLE_NAME: props.competitorRoleName ?? COMPETITOR_ROLE_NAME_DEFAULT,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: "node20",
        sourceMap: true,
        externalModules: [],
      },
    });

    this.rule = new Rule(this, "ScheduleRule", {
      description: "Periodic CFn status polling for non-terminal deployments.",
      schedule: Schedule.rate(props.schedulePeriod ?? Duration.minutes(1)),
      targets: [new LambdaTarget(this.fn)],
    });
  }
}
