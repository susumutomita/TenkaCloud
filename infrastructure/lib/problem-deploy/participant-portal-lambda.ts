import * as path from "node:path";
import { Duration } from "aws-cdk-lib";
import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import {
  ManagedPolicy,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import {
  Architecture,
  type FunctionUrl,
  FunctionUrlAuthType,
  HttpMethod,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

export interface ParticipantPortalLambdaProps {
  readonly deploymentsTable: ITable;
  /**
   * `{ [problemId]: { kind, flagOutputKey, points, ... } }` 形の scoring 設定。
   * `discoverProblemsScoring` で metadata.json から自動収集して synth 時に注入する。
   * 競技者が submit-flag したとき、この map を参照して採点する。
   */
  readonly problemsScoring: Readonly<Record<string, unknown>>;
}

/**
 * Participant Portal backend Lambda。Function URL (AuthType=NONE) で公開し、
 * `Authorization: Bearer <teamLoginKey>` を Lambda 内で検証する。
 *
 * IAM は最小限: Deployments テーブルと GSI2 への Query 権限のみ。Worker / API
 * Lambda が持つ CFn AssumeRole / EventBridge / DDB 書き込み権限は付与しない。
 */
export class ParticipantPortalLambda extends Construct {
  public readonly fn: NodejsFunction;
  public readonly url: FunctionUrl;

  constructor(scope: Construct, id: string, props: ParticipantPortalLambdaProps) {
    super(scope, id);

    const role = new Role(this, "Role", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      inlinePolicies: {
        DeploymentsRead: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ["dynamodb:Query"],
              resources: [
                props.deploymentsTable.tableArn,
                `${props.deploymentsTable.tableArn}/index/GSI2`,
              ],
            }),
            // 競技者の表示名 (`displayTeamName`) 更新のみ。テーブル全体に対する
            // UpdateItem だが、Lambda コードは GSI2 経由で取得した自分の行しか
            // 触らないので、実質的な書き込み対象は teamLoginKey 所有者の 1 行に限られる。
            new PolicyStatement({
              actions: ["dynamodb:UpdateItem"],
              resources: [props.deploymentsTable.tableArn],
            }),
          ],
        }),
      },
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });

    this.fn = new NodejsFunction(this, "Function", {
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      entry: path.resolve(__dirname, "handlers/participant-handler/index.ts"),
      handler: "handler",
      timeout: Duration.seconds(10),
      memorySize: 256,
      role,
      environment: {
        DEPLOYMENTS_TABLE_NAME: props.deploymentsTable.tableName,
        BATTLE_PROBLEMS_SCORING: JSON.stringify(props.problemsScoring),
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: "node20",
        sourceMap: true,
        externalModules: [],
      },
    });

    this.url = this.fn.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ["*"],
        allowedMethods: [HttpMethod.GET, HttpMethod.PATCH, HttpMethod.POST],
        allowedHeaders: ["content-type", "authorization"],
        maxAge: Duration.minutes(10),
      },
    });
  }
}
