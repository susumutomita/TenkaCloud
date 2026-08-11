import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { RemovalPolicy } from "aws-cdk-lib";
import { BlockPublicAccess, Bucket, BucketEncryption, type IBucket } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import { deploymentLogGroup } from "../utils/deployment-log-group.js";

export interface CoordinationPluginBundleProps {
  /**
   * `{ [problemId]: bundledMjs }` (= `bundleCoordinationPlugins` の出力)。 各 problem の coordination
   * plugin を SDK inline 済み self-contained ESM に bundle したもの。
   */
  readonly bundles: Readonly<Record<string, string>>;
}

/**
 * Issue #1420: synth-bundle 済み coordination plugin を **専用 bucket** に配置する。
 *
 * CoordinationDispatcher Lambda が runtime に `coordination/<problemId>.mjs` を download して
 * dynamic import する。bucket は private (BlockPublicAccess)、SSL 必須、S3 managed 暗号化とし、
 * dispatcher だけに read 権限を与えて未信頼コードの到達範囲を絞る。
 */
export class CoordinationPluginBundle extends Construct {
  public readonly bucket: IBucket;

  constructor(scope: Construct, id: string, props: CoordinationPluginBundleProps) {
    super(scope, id);

    this.bucket = new Bucket(this, "Bucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // plugin bundle は catalog から都度再生成できる派生物なので ephemeral で良い。
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // synth で各 plugin の .mjs を staging dir に書き出し、 coordination/ prefix で upload。
    const staging = mkdtempSync(path.join(tmpdir(), "coord-bundle-"));
    const dest = path.join(staging, "coordination");
    mkdirSync(dest, { recursive: true });
    for (const [problemId, js] of Object.entries(props.bundles)) {
      writeFileSync(path.join(dest, `${problemId}.mjs`), js);
    }

    new BucketDeployment(this, "Deploy", {
      logGroup: deploymentLogGroup(this, "DeployLogs"),
      sources: [Source.asset(staging)],
      destinationBucket: this.bucket,
    });
  }
}
