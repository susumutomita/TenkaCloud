import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { RemovalPolicy, Stack } from "aws-cdk-lib";
import { AnyPrincipal, Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import type { InstallationCompetitorConfig } from "../problem-deploy/control-data/domain/competitor-accounts.js";
import { deploymentLogGroup } from "../utils/deployment-log-group.js";
import { repositoryArtifactFile } from "./execution-artifacts.js";
import { assertCommercialRegion } from "./regions.js";
import { cloudStackNames } from "./stack-names.js";

export function installationCompetitorConfig(
  account: string,
  region: string,
  environment: string,
): InstallationCompetitorConfig {
  if (!/^\d{12}$/u.test(account)) throw new Error("An explicit control-plane account is required.");
  assertCommercialRegion(region);
  cloudStackNames(environment);
  const installation = createHash("sha256")
    .update(JSON.stringify([account, region, environment]))
    .digest("hex")
    .slice(0, 24);
  return {
    roleName: `TenkaCloud-${installation}-deploy-Role`,
    externalIdParameterArn: `arn:aws:ssm:${region}:${account}:parameter/tenkacloud/cloud/${installation}/external-id`,
  };
}
/** The account is chosen in the existing Admin registry; the role name and trust tags are never caller-controlled. */
export function competitorAssumeRolePolicy(config: InstallationCompetitorConfig): PolicyStatement {
  const identity = /^TenkaCloud-([a-f0-9]{24})-deploy-Role$/u.exec(config.roleName)?.[1];
  if (
    !identity ||
    !new RegExp(
      `^arn:aws:ssm:[a-z0-9-]+:\\d{12}:parameter/tenkacloud/cloud/${identity}/external-id$`,
      "u",
    ).test(config.externalIdParameterArn)
  )
    throw new Error("Invalid installation competitor role or ExternalId.");
  return new PolicyStatement({
    actions: ["sts:AssumeRole"],
    resources: [`arn:aws:iam::*:role/${config.roleName}`],
    conditions: {
      Null: { "sts:ExternalId": "false" },
      StringEquals: {
        "aws:ResourceTag/TenkaCloud:Purpose": "competitor-deploy",
        "aws:ResourceTag/TenkaCloud:Installation": config.roleName,
      },
    },
  });
}

/** Historical competitor-bootstrap hosting: the existing modal's CloudFormation TemplateURL has a real consumer. */
export class CompetitorBootstrapHosting extends Construct {
  readonly templateUrl: string;
  constructor(scope: Construct, id: string, repositoryRoot: string) {
    super(scope, id);
    const contents = readFileSync(
      repositoryArtifactFile(repositoryRoot, "infrastructure/templates/competitor-bootstrap.yaml"),
      "utf8",
    );
    // eslint-disable-next-line sonarjs/aws-s3-bucket-versioning -- This bucket serves one public, reproducible bootstrap template; no event data or credentials are uploaded.
    const bucket = new Bucket(this, "Bucket", {
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: new BlockPublicAccess({
        blockPublicAcls: true,
        ignorePublicAcls: true,
        blockPublicPolicy: false,
        restrictPublicBuckets: false,
      }),
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    bucket.addToResourcePolicy(
      new PolicyStatement({
        // eslint-disable-next-line sonarjs/aws-iam-public-access -- Only this public, secret-free YAML object is readable; the existing CloudFormation Quick-create requires an S3 TemplateURL. No bucket listing or other object is public.
        principals: [new AnyPrincipal()],
        actions: ["s3:GetObject"],
        resources: [bucket.arnForObjects("competitor-bootstrap.yaml")],
      }),
    );
    new BucketDeployment(this, "Template", {
      logGroup: deploymentLogGroup(this),
      destinationBucket: bucket,
      sources: [Source.data("competitor-bootstrap.yaml", contents)],
      prune: false,
      retainOnDelete: false,
    });
    this.templateUrl = `https://${bucket.bucketName}.s3.${Stack.of(this).region}.amazonaws.com/competitor-bootstrap.yaml`;
  }
}

/** The competitor AdministratorAccess exception can never be exercised against the platform account. */
export function denyControlPlaneAssumeRole(account: string): PolicyStatement {
  if (!/^\d{12}$/u.test(account)) throw new Error("An explicit control-plane account is required.");
  return new PolicyStatement({
    effect: Effect.DENY,
    actions: ["sts:AssumeRole"],
    resources: [`arn:aws:iam::${account}:role/*`],
  });
}
