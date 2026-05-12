import * as path from "node:path";
import { Duration } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

export interface MicroserviceMigrationRegistrationApiLambdaProps {
  /** `MicroserviceMigrationScoresTable` の DDB (RW)。 */
  readonly scoresTable: Table;
}

/**
 * Microservice Migration Battle (Phase 2 / Issue #606) の endpoint 登録 API Lambda。
 *
 * tenant API (TenantTemplateStack の REST API + Cognito JWT authorizer) から
 * `LambdaIntegration` で invoke される。Hono routes:
 *   POST /problems/microservice-migration-battle/endpoints — slot / url を upsert
 *   GET  /problems/microservice-migration-battle/endpoints — 登録済 + 観測結果を一覧
 *
 * IAM scope は `scoresTable` 全 RW のみ (= polling Lambda が別 IAM で観測列を書く設計)。
 */
export class MicroserviceMigrationRegistrationApiLambda extends Construct {
  public readonly fn: NodejsFunction;

  constructor(
    scope: Construct,
    id: string,
    props: MicroserviceMigrationRegistrationApiLambdaProps,
  ) {
    super(scope, id);

    this.fn = new NodejsFunction(this, "Function", {
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      entry: path.resolve(
        __dirname,
        "handlers/microservice-migration-registration-handler/index.ts",
      ),
      handler: "handler",
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        MICROSERVICE_MIGRATION_SCORES_TABLE_NAME: props.scoresTable.tableName,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: "node20",
        sourceMap: true,
        externalModules: [],
      },
    });

    props.scoresTable.grantReadWriteData(this.fn);
  }
}
