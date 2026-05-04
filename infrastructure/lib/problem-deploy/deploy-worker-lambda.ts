import * as path from "node:path";
import { Duration } from "aws-cdk-lib";
import type { IEventBus } from "aws-cdk-lib/aws-events";
import { Rule } from "aws-cdk-lib/aws-events";
import { LambdaFunction as LambdaTarget } from "aws-cdk-lib/aws-events-targets";
import type { IRole } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

export interface DeployWorkerLambdaProps {
  readonly deploymentsTableName: string;
  readonly eventBus: IEventBus;
  readonly executionRole: IRole;
  /** Bootstrap CFn (PR-A) で発行された ExternalId を SSM 等から渡す。 */
  readonly externalId: string;
  /** 競技者側の AssumeRole 名 (PR-A bootstrap CFn の default と一致)。 */
  readonly competitorRoleName?: string;
}

/**
 * `tenkacloud.problem` / `DeployRequested` イベントを受けて、競技者アカウントへ
 * AssumeRole + CFn CreateStack を実行する Lambda。
 *
 * Lambda asset には `problems/` ディレクトリ全体を同梱する (commandHooks.afterBundling)。
 * ランタイムは `__dirname/problems/<category>/<problemId>/template.yaml` を読む。
 */
export class DeployWorkerLambda extends Construct {
  public readonly fn: NodejsFunction;
  public readonly rule: Rule;

  constructor(scope: Construct, id: string, props: DeployWorkerLambdaProps) {
    super(scope, id);

    const repoRoot = path.resolve(__dirname, "..", "..", "..");
    const problemsDir = path.join(repoRoot, "problems");

    this.fn = new NodejsFunction(this, "Function", {
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      entry: path.resolve(__dirname, "handlers/deploy-worker/index.ts"),
      handler: "handler",
      timeout: Duration.minutes(5),
      memorySize: 512,
      role: props.executionRole,
      environment: {
        DEPLOYMENTS_TABLE_NAME: props.deploymentsTableName,
        DEPLOY_EVENT_BUS_NAME: props.eventBus.eventBusName,
        DEPLOY_EXTERNAL_ID: props.externalId,
        COMPETITOR_ROLE_NAME: props.competitorRoleName ?? "TenkaCloud-CompetitorDeploy-Role",
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: "node20",
        sourceMap: true,
        externalModules: [],
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_inputDir, outputDir) => [
            // Lambda asset に problems/ をそのまま同梱。Worker handler は
            // path.resolve(__dirname, "problems") から template.yaml を読む。
            `cp -R "${problemsDir}" "${outputDir}/problems"`,
          ],
        },
      },
    });

    this.rule = new Rule(this, "DeployRequestedRule", {
      eventBus: props.eventBus,
      description: "Route tenkacloud.problem DeployRequested events to the worker Lambda.",
      eventPattern: {
        source: ["tenkacloud.problem"],
        detailType: ["DeployRequested"],
      },
      targets: [new LambdaTarget(this.fn)],
    });
  }
}
