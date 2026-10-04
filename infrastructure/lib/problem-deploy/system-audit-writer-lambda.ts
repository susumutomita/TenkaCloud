import * as path from "node:path";
import { Duration } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import { type IEventBus, Rule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";
import { defineNodejsFunction } from "../utils/define-nodejs-function.js";
import { SBT_ONBOARDING_DETAIL_TYPES } from "./handlers/system-audit-writer/sbt-detail-types.js";

export interface SystemAuditWriterLambdaProps {
  readonly eventBus: IEventBus;
  /** Legacy constructor inputs remain accepted; the retired handler never reads storage. */
  readonly adminAuditLogTable?: Table;
  readonly environmentName: string;
  readonly auditLogEnabled?: boolean;
  readonly controlDataBackend?: string;
  readonly tursoDatabaseUrl?: string;
  readonly tursoAuthTokenParameterName?: string;
  /** Preserve the existing conditional rule identity for Lambda-deploy installations. */
  readonly deployViaLambda?: boolean;
}

/** Retained Lambda/log group and disabled rules preserve deployed resource identities. */
export class SystemAuditWriterLambda extends Construct {
  public readonly fn: NodejsFunction;
  public readonly rule: Rule;
  /**
   * Issue #1029: CodeBuild Build State Change event (= aws.codebuild source) を listen する
   * 別 rule。 default event bus にぶら下がるため `rule` (SBT bus) とは分離した EventBridge
   * Rule 構築になる。
   */
  public readonly codeBuildFailureRule: Rule;
  /**
   * Issue #2291: Lambda deploy 経路の失敗 event (`DeployCreate` state machine が
   * SBT bus に PutEvents する `TenkaCloud Deploy Failed`) を listen する Rule。 `deployViaLambda`
   * が true のときだけ生成する (= CodeBuild path しか無い環境では byte 互換で undefined)。
   */
  public readonly deployFailureRule?: Rule;

  constructor(scope: Construct, id: string, props: SystemAuditWriterLambdaProps) {
    super(scope, id);

    this.fn = defineNodejsFunction(this, {
      entry: path.resolve(import.meta.dirname, "handlers/system-audit-writer/index.ts"),
      timeout: Duration.seconds(10),
      // Keep the existing function configuration and log-group identity.
      memorySize: 1024,
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
      },
    });

    // Retain rule resources, but never subscribe the retired writer to new events.
    this.rule = new Rule(this, "Rule", {
      enabled: false,
      eventBus: props.eventBus,
      description:
        "Route SBT tenant onboarding/offboarding events to SystemAuditWriter Lambda (Issue #1034)",
      eventPattern: {
        detailType: [...SBT_ONBOARDING_DETAIL_TYPES],
      },
      targets: [new LambdaFunction(this.fn)],
    });

    this.codeBuildFailureRule = new Rule(this, "CodeBuildFailureRule", {
      enabled: false,
      description:
        "Route CodeBuild FAILED / FAULT / STOPPED / TIMED_OUT events to SystemAuditWriter Lambda (Issue #1029)",
      eventPattern: {
        source: ["aws.codebuild"],
        detailType: ["CodeBuild Build State Change"],
        detail: {
          "build-status": ["FAILED", "FAULT", "STOPPED", "TIMED_OUT"],
        },
      },
      targets: [new LambdaFunction(this.fn)],
    });

    if (props.deployViaLambda) {
      this.deployFailureRule = new Rule(this, "DeployFailureRule", {
        enabled: false,
        eventBus: props.eventBus,
        description:
          "Route TenkaCloud Deploy Failed (Lambda deploy path) events to SystemAuditWriter Lambda (Issue #2291)",
        eventPattern: {
          source: ["tenkacloud.problem-deploy"],
          detailType: ["TenkaCloud Deploy Failed"],
        },
        targets: [new LambdaFunction(this.fn)],
      });
    }
  }
}
