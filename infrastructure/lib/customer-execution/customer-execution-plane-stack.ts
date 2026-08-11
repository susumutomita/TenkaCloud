import * as path from "node:path";
import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import {
  Effect,
  ManagedPolicy,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Architecture } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { Queue } from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { LAMBDA_LOG_RETENTION, LAMBDA_NODEJS_RUNTIME } from "../utils/lambda-runtime.js";

/**
 * Issue #1727: customer-execution mode の CDK 配線。
 *
 * **customer 側のアカウントに** deploy する独立 stack。 hosted control plane が署名した
 * CloudActionIntent を SQS で受け、 ローカル CFn 権限で deploy/destroy する。
 *
 * 核心: ここに作る IAM の中に **control plane を trust する経路は無い**。
 * deploy 権限は customer 所有の CFn service role に閉じ、 hosted control plane からは
 * 構造的に到達できない (= control plane を侵害しても、 この権限は奪えない)。
 */
export interface CustomerExecutionPlaneStackProps extends StackProps {
  /** この plane の識別子 (= intent.audience と一致させる)。 */
  readonly planeAudience: string;
  /** deploy を許す provider account id (= 通常この dedicated challenge account)。 */
  readonly allowedAccountIds: readonly string[];
  /** deploy を許す region。 */
  readonly allowedRegions: readonly string[];
  /** ローカルで承認済みの problem id allowlist。 */
  readonly approvedProblemIds: readonly string[];
  /** JWS 検証 secret を保持する SSM SecureString パラメータ名。 */
  readonly verifySecretParameterName: string;
  /** 見積コスト上限 (USD)。 default 50。 */
  readonly maxEstimatedCostUsd?: number;
  /** intent TTL のローカル上限 (秒)。 default 900。 */
  readonly maxTtlSeconds?: number;
}

export class CustomerExecutionPlaneStack extends Stack {
  readonly intentQueue: Queue;
  readonly nonceTable: Table;
  readonly cfnServiceRole: Role;
  readonly executionFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: CustomerExecutionPlaneStackProps) {
    super(scope, id, props);

    const deadLetterQueue = new Queue(this, "IntentDlq", {
      retentionPeriod: Duration.days(14),
    });
    this.intentQueue = new Queue(this, "IntentQueue", {
      visibilityTimeout: Duration.minutes(6),
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 3 },
    });

    // replay 防止: nonce を 1 度しか受理しない。 1/1 PROVISIONED + TTL GC (Free Tier 整合)。
    this.nonceTable = new Table(this, "NonceTable", {
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PROVISIONED,
      readCapacity: 1,
      writeCapacity: 1,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
    });

    // CloudFormation がチャレンジ stack を配置するときに assume する service role。
    // broad な権限は **この dedicated challenge account に閉じる**。
    this.cfnServiceRole = new Role(this, "CfnServiceRole", {
      assumedBy: new ServicePrincipal("cloudformation.amazonaws.com"),
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName("AdministratorAccess")],
      description: "Local CloudFormation execution authority for TenkaCloud challenge deploys.",
    });

    const fn = new NodejsFunction(this, "Function", {
      // このスタックはどの App にも未配線で App-scope の LogGroupRetention Aspect が届かないため、
      // retention を inline で設定する (= 配線され次第そのまま 1 日保持で synth される)。
      logGroup: new LogGroup(this, "FunctionLogGroup", {
        removalPolicy: RemovalPolicy.DESTROY,
        retention: LAMBDA_LOG_RETENTION,
      }),
      runtime: LAMBDA_NODEJS_RUNTIME,
      architecture: Architecture.ARM_64,
      entry: path.resolve(import.meta.dirname, "handler/index.ts"),
      handler: "handler",
      timeout: Duration.minutes(5),
      memorySize: 256,
      environment: {
        NONCE_TABLE_NAME: this.nonceTable.tableName,
        VERIFY_SECRET_PARAM: props.verifySecretParameterName,
        PLANE_AUDIENCE: props.planeAudience,
        ALLOWED_ACCOUNT_IDS: props.allowedAccountIds.join(","),
        ALLOWED_REGIONS: props.allowedRegions.join(","),
        APPROVED_PROBLEM_IDS: props.approvedProblemIds.join(","),
        MAX_TTL_SECONDS: String(props.maxTtlSeconds ?? 900),
        MAX_ESTIMATED_COST_USD: String(props.maxEstimatedCostUsd ?? 50),
        CFN_SERVICE_ROLE_ARN: this.cfnServiceRole.roleArn,
        ALLOW_PRIVILEGE_ESCALATION: "false",
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: { minify: true, sourceMap: true },
    });
    this.executionFunction = fn;

    fn.addEventSource(new SqsEventSource(this.intentQueue, { reportBatchItemFailures: true }));
    this.nonceTable.grantWriteData(fn);

    // ローカル CFn 操作: tc-* stack のみ。 control plane への AssumeRole は付与しない。
    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "cloudformation:CreateStack",
          "cloudformation:UpdateStack",
          "cloudformation:DeleteStack",
          "cloudformation:DescribeStacks",
        ],
        resources: [`arn:aws:cloudformation:*:${this.account}:stack/tc-*/*`],
      }),
    );
    // CFn に service role を渡す権限 (= PassRole)。 PassedToService を CFn に限定。
    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["iam:PassRole"],
        resources: [this.cfnServiceRole.roleArn],
        conditions: { StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" } },
      }),
    );
    // 検証 secret (SecureString) の read。
    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:*:${this.account}:parameter${
            props.verifySecretParameterName.startsWith("/")
              ? props.verifySecretParameterName
              : `/${props.verifySecretParameterName}`
          }`,
        ],
      }),
    );
  }
}
