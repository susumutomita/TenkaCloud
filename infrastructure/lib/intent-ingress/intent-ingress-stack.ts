import * as path from "node:path";
import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { EventBus, type IEventBus } from "aws-cdk-lib/aws-events";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import {
  Architecture,
  type FunctionUrl,
  FunctionUrlAuthType,
  HttpMethod,
} from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import { LAMBDA_LOG_RETENTION, LAMBDA_NODEJS_RUNTIME } from "../utils/lambda-runtime.js";

/**
 * ADR-049 Phase 4 (Issue #2293) — signed-intent ingress transport stack.
 *
 * Stands up the HTTPS ingress for JWS-signed `CloudActionIntent`s emitted by the
 * Cloudflare control plane: a Function URL Lambda that verifies + authorizes the
 * intent and re-emits the FROZEN EventBridge deploy event onto the existing bus, so
 * every downstream state machine is untouched.
 *
 * Like `CustomerExecutionPlaneStack` (ADR-039 §7), this is a standalone, deployable
 * stack that is intentionally NOT wired into any `bin/*.ts` yet: the ingress cutover
 * is a separate operational step. Because it is unwired, the App-scope LogGroup
 * retention Aspect never reaches it, so retention is set inline.
 */
export interface IntentIngressStackProps extends StackProps {
  /** SSM SecureString parameter holding the JWS verification secret. */
  readonly verifySecretParameterName: string;
  /** SSM String parameter holding the public ES256 verification JWK. */
  readonly verifyPublicKeyParameterName: string;
  /**
   * Existing deploy EventBridge bus ARN. When provided the frozen event is re-emitted
   * onto that bus (production wiring); when omitted a local bus is created so the stack
   * synthesizes and deploys standalone.
   */
  readonly eventBusArn?: string;
  /** When set, an ingressed intent's `audience` must equal this. */
  readonly expectedAudience?: string;
  /** Non-empty → only these tenants may ingress. */
  readonly allowedTenantIds?: readonly string[];
  /** Non-empty → only these events may ingress. */
  readonly allowedEventIds?: readonly string[];
  /** problemId → problemDir catalog (mirrors the deploy handler's `BATTLE_PROBLEMS_CATALOG`). */
  readonly problemsCatalog: Readonly<Record<string, string>>;
  /** Existing ProblemDeployBackend CompetitorAccounts table name. */
  readonly competitorAccountsTableName: string;
  /** Existing ProblemDeployBackend CompetitorAccounts table ARN. */
  readonly competitorAccountsTableArn: string;
  /** Deployment stage used to derive the tenant ExternalId SSM parameter path. */
  readonly environmentName: string;
}

export class IntentIngressStack extends Stack {
  readonly nonceTable: Table;
  readonly ingressFunction: NodejsFunction;
  readonly functionUrl: FunctionUrl;
  readonly eventBus: IEventBus;

  constructor(scope: Construct, id: string, props: IntentIngressStackProps) {
    super(scope, id, props);

    // Replay defense: accept a nonce only once. 1/1 PROVISIONED + TTL GC (Free Tier).
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

    // Import the existing deploy bus when wired; otherwise create a local one so the
    // stack stands alone. Same pattern as ProblemDeployBackendStack.
    this.eventBus = props.eventBusArn
      ? EventBus.fromEventBusArn(this, "ImportedEventBus", props.eventBusArn)
      : new EventBus(this, "LocalEventBus", {
          eventBusName: `tenkacloud-intent-ingress-local-${Stack.of(this).stackName}`,
        });

    const fn = new NodejsFunction(this, "Function", {
      // Unwired stack: set retention inline (the App-scope retention Aspect never reaches here).
      logGroup: new LogGroup(this, "FunctionLogGroup", {
        removalPolicy: RemovalPolicy.DESTROY,
        retention: LAMBDA_LOG_RETENTION,
      }),
      runtime: LAMBDA_NODEJS_RUNTIME,
      architecture: Architecture.ARM_64,
      entry: path.resolve(import.meta.dirname, "handler/index.ts"),
      handler: "handler",
      timeout: Duration.minutes(1),
      memorySize: 256,
      environment: {
        NONCE_TABLE_NAME: this.nonceTable.tableName,
        VERIFY_SECRET_PARAM: props.verifySecretParameterName,
        VERIFY_PUBLIC_KEY_PARAM: props.verifyPublicKeyParameterName,
        DEPLOY_EVENT_BUS_NAME: this.eventBus.eventBusName,
        COMPETITOR_ACCOUNTS_TABLE_NAME: props.competitorAccountsTableName,
        DEPLOY_ENVIRONMENT: props.environmentName,
        ...(props.expectedAudience ? { EXPECTED_AUDIENCE: props.expectedAudience } : {}),
        ...(props.allowedTenantIds && props.allowedTenantIds.length > 0
          ? { ALLOWED_TENANT_IDS: props.allowedTenantIds.join(",") }
          : {}),
        ...(props.allowedEventIds && props.allowedEventIds.length > 0
          ? { ALLOWED_EVENT_IDS: props.allowedEventIds.join(",") }
          : {}),
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        minify: true,
        sourceMap: true,
        // #1308-style: inject the (potentially large) catalog as a build-time literal so it
        // never counts against the 4 KB Lambda env limit. The handler reads process.env.PROBLEMS_CATALOG.
        define: {
          "process.env.PROBLEMS_CATALOG": JSON.stringify(JSON.stringify(props.problemsCatalog)),
        },
      },
    });
    this.ingressFunction = fn;

    // Public HTTPS ingress. The JWS signature (verified in-Lambda) is the authentication;
    // the Function URL itself is unauthenticated, mirroring the participant portal.
    this.functionUrl = fn.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ["*"],
        allowedMethods: [HttpMethod.POST],
        allowedHeaders: ["content-type"],
        maxAge: Duration.minutes(10),
      },
    });

    // Least-privilege grants.
    // Nonce store performs only a conditional PutItem, so write-only is sufficient.
    this.nonceTable.grantWriteData(fn);
    // Re-emit onto the deploy bus.
    this.eventBus.grantPutEventsTo(fn);
    // Resolve only the requested tenant/account row; no scan/query or write access.
    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:GetItem"],
        resources: [props.competitorAccountsTableArn],
      }),
    );
    // Read the JWS verification secret (SecureString), scoped to the exact parameter ARN.
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
    // The ES256 public JWK is not secret: read its SSM String parameter without KMS access.
    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:*:${this.account}:parameter${
            props.verifyPublicKeyParameterName.startsWith("/")
              ? props.verifyPublicKeyParameterName
              : `/${props.verifyPublicKeyParameterName}`
          }`,
        ],
      }),
    );
  }
}
