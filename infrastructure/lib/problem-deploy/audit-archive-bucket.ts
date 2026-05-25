import * as path from "node:path";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import type { Table } from "aws-cdk-lib/aws-dynamodb";
import { Architecture, StartingPosition } from "aws-cdk-lib/aws-lambda";
import { DynamoEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  ObjectLockRetention,
  StorageClass,
} from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import {
  LAMBDA_NODEJS_BUNDLING_TARGET,
  LAMBDA_NODEJS_RUNTIME,
  LAMBDA_SOURCE_MAP_ENABLED,
} from "../utils/lambda-runtime.js";

/**
 * Issue #1341 (#1335 Phase 3): SOC2 immutable audit archive bucket + DDB Stream → S3 writer Lambda。
 *
 * 旧状態: AdminAuditLog DDB は TTL 90 日。 SOC2 typical 1-year + finance 7-year retention に
 * 耐えるためには (a) DDB TTL を 365 まで延ばす + (b) より長期は immutable storage に逃がす
 * の二段構えが必要。 本 construct は (b) を担い、 Object Lock compliance mode (= admin / root でも
 * 上書き / 削除不可) + lifecycle Glacier 移行 (= 90 日後) + 7-year expiration を組む。
 *
 * 物理 impact:
 *   - 新 S3 bucket (= ObjectLock enabled at CREATE、 後付け不可)
 *   - 新 Lambda (= DDB Stream consumer、 archive bucket への PutObject 権限のみ)
 *   - AdminAuditLog Table に Stream (NEW_IMAGE) を生やす (= caller stack が用意した table を mutate)
 *
 * ⚠️ [USER-REVIEW]: CDK 追加部分。 maintainer (= user) の責務領域 (AGENTS.md role split) のため、
 * このファイルは proposal として committed。 deploy 前に user 側で IAM / bucket name の最終確認をお願いする。
 */
export interface AuditArchiveBucketProps {
  /** Stream を引く Source: AdminAuditLog DDB Table。 caller stack が `stream: NEW_IMAGE` を有効化済。 */
  readonly adminAuditLogTable: Table;
  /** 環境名 (`development` / `staging` / `production`)。 lifecycle 用 tag に焼く。 */
  readonly environmentName: string;
  /**
   * Object Lock の保持日数。 SOC2 CC6 immutability で 365 日 (= 1 year) を default にする。
   * finance 7-year は lifecycle expiration で担保し、 ObjectLock は最短 1 年に固定 (= 上書き耐性のみ)。
   */
  readonly objectLockRetentionDays?: number;
}

const DEFAULT_OBJECT_LOCK_DAYS = 365;
const GLACIER_TRANSITION_DAYS = 90;
const EXPIRATION_DAYS = 365 * 7; // SOC2 + finance 7-year retention

export class AuditArchiveBucket extends Construct {
  public readonly bucket: Bucket;
  public readonly writerLambda: NodejsFunction;

  constructor(scope: Construct, id: string, props: AuditArchiveBucketProps) {
    super(scope, id);

    const retentionDays = props.objectLockRetentionDays ?? DEFAULT_OBJECT_LOCK_DAYS;

    // Object Lock は bucket 作成時のみ有効化可能 (= 後付け不可)。 retention compliance mode は
    // admin / root でも上書き / 削除 / shorten 不可なので、 SOC2 immutability 要件と整合する。
    this.bucket = new Bucket(this, "Bucket", {
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      versioned: true, // Object Lock の前提条件 (= S3 が要求する)
      objectLockEnabled: true,
      objectLockDefaultRetention: ObjectLockRetention.compliance(Duration.days(retentionDays)),
      lifecycleRules: [
        {
          id: "GlacierThenExpire",
          enabled: true,
          transitions: [
            {
              storageClass: StorageClass.GLACIER,
              transitionAfter: Duration.days(GLACIER_TRANSITION_DAYS),
            },
          ],
          expiration: Duration.days(EXPIRATION_DAYS),
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN, // audit は stack delete で消さない
    });

    // DDB Stream → Lambda → PutObject の writer。 archiveRecord handler 実装は
    // `handlers/audit-archive-writer/index.ts`、 INSERT 以外は skip して TTL expiry を archive に書かない。
    this.writerLambda = new NodejsFunction(this, "WriterFunction", {
      runtime: LAMBDA_NODEJS_RUNTIME,
      architecture: Architecture.ARM_64,
      entry: path.resolve(import.meta.dirname, "handlers/audit-archive-writer/index.ts"),
      handler: "handler",
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        AUDIT_ARCHIVE_BUCKET_NAME: this.bucket.bucketName,
        DEPLOY_ENVIRONMENT: props.environmentName,
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        target: LAMBDA_NODEJS_BUNDLING_TARGET,
        sourceMap: LAMBDA_SOURCE_MAP_ENABLED,
        externalModules: [],
      },
    });

    // DDB Stream を Lambda に接続。 NEW_IMAGE で十分 (= INSERT 専用 archive)。
    // batchSize 100 / maxBatchingWindow 1 分は audit の低 QPS でも遅延と cost を釣り合わせる典型値。
    this.writerLambda.addEventSource(
      new DynamoEventSource(props.adminAuditLogTable, {
        startingPosition: StartingPosition.TRIM_HORIZON,
        batchSize: 100,
        maxBatchingWindow: Duration.minutes(1),
        retryAttempts: 3,
      }),
    );

    // bucket への write 権限のみ (= read 権限は別 Lambda が持つ、 最小権限)
    this.bucket.grantPut(this.writerLambda);
  }
}
