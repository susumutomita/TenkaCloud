import * as path from "node:path";
import { Duration } from "aws-cdk-lib";
import { Table } from "aws-cdk-lib/aws-dynamodb";
import type { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { defineNodejsFunction } from "../utils/define-nodejs-function.js";

export interface EventRuntimeArchiveProps {
  readonly eventId: string;
  readonly deploymentsTableName: string;
  readonly archiveBucketName: string;
}

/** Event-scoped raw score-event archive function invoked immediately before stack destroy. */
export class EventRuntimeArchive extends Construct {
  public readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: EventRuntimeArchiveProps) {
    super(scope, id);
    const deploymentsTable = Table.fromTableName(
      this,
      "DeploymentsTable",
      props.deploymentsTableName,
    );
    const archiveBucket = Bucket.fromBucketName(this, "ArchiveBucket", props.archiveBucketName);

    this.fn = defineNodejsFunction(this, {
      entry: path.resolve(import.meta.dirname, "handlers/runtime-score-archive.ts"),
      timeout: Duration.minutes(15),
      memorySize: 512,
      reservedConcurrentExecutions: 1,
      environment: {
        DEPLOYMENTS_TABLE_NAME: deploymentsTable.tableName,
        SCORE_ARCHIVE_BUCKET_NAME: archiveBucket.bucketName,
        NODE_OPTIONS: "--enable-source-maps",
      },
    });
    deploymentsTable.grantReadData(this.fn);
    archiveBucket.grantPut(this.fn, `events/${props.eventId}/score-events/*`);
    this.fn.configureAsyncInvoke({
      retryAttempts: 0,
      maxEventAge: Duration.minutes(15),
    });
  }
}
