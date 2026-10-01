import { createHash } from "node:crypto";
import { join } from "node:path";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import {
  AuthorizationType,
  type CfnAuthorizer,
  CognitoUserPoolsAuthorizer,
  EndpointType,
  LambdaIntegration,
  RestApi,
} from "aws-cdk-lib/aws-apigateway";
import {
  AccountRecovery,
  ClientAttributes,
  Mfa,
  OAuthScope,
  StringAttribute,
  UserPool,
  UserPoolClientIdentityProvider,
} from "aws-cdk-lib/aws-cognito";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import { CLOUD_EVENT_LIMITS } from "../problem-deploy/control-data/domain/events.js";
import type { CloudDataStack } from "./data-stack.js";
import { CloudHosting } from "./hosting.js";
import { scopeInvalidationPermissions } from "./invalidation-permissions.js";

export interface CloudApplicationStackProps extends StackProps {
  readonly repositoryRoot: string;
  readonly consoleAssets: string;
  readonly environment: string;
  readonly backend: CloudDataStack;
}
/** Restored single-installation Cognito/API/hosting composition, without SBT or tenant stack factories. */
export class CloudApplicationStack extends Stack {
  constructor(scope: Construct, id: string, props: CloudApplicationStackProps) {
    super(scope, id, props);
    const consoleSite = new CloudHosting(this, "OrganizerConsole", props.consoleAssets);
    const pool = new UserPool(this, "OrganizerUserPool", {
      removalPolicy: RemovalPolicy.RETAIN,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      mfa: Mfa.REQUIRED,
      mfaSecondFactor: { sms: false, otp: true },
      customAttributes: { userRole: new StringAttribute({ mutable: true }) },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },
    });
    const client = pool.addClient("OrganizerClient", {
      generateSecret: false,
      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
      readAttributes: new ClientAttributes()
        .withStandardAttributes({ email: true, emailVerified: true })
        .withCustomAttributes("userRole"),
      writeAttributes: new ClientAttributes().withStandardAttributes({ email: true }),
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        callbackUrls: [`${consoleSite.url}/callback`],
        logoutUrls: [`${consoleSite.url}/`, `${consoleSite.url}/login`],
      },
      preventUserExistenceErrors: true,
    });
    const domainSuffix = createHash("sha256")
      .update(`${props.environment}:${this.region}`)
      .digest("hex")
      .slice(0, 12);
    const domain = pool.addDomain("OrganizerDomain", {
      cognitoDomain: {
        domainPrefix: `tenkacloud-${this.account}-${domainSuffix}`,
      },
    });
    const issuer = `https://cognito-idp.${this.region}.${this.urlSuffix}/${pool.userPoolId}`;
    const origins = [consoleSite.url, props.backend.portal.url];
    const apiLogs = new LogGroup(this, "ApiLogs", { retention: RetentionDays.ONE_WEEK });
    const apiRole = new Role(this, "ApiRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
    });
    apiLogs.grantWrite(apiRole);
    const apiHandler = new NodejsFunction(this, "CloudApi", {
      runtime: Runtime.NODEJS_24_X,
      entry: join(
        props.repositoryRoot,
        "infrastructure/lib/problem-deploy/handlers/cloud-api/index.ts",
      ),
      handler: "handler",
      depsLockFilePath: join(props.repositoryRoot, "bun.lock"),
      projectRoot: props.repositoryRoot,
      timeout: Duration.seconds(15),
      memorySize: 256,
      role: apiRole,
      logGroup: apiLogs,
      bundling: { bundleAwsSDK: true, minify: true, target: "node24" },
      environment: {
        EVENTS_TABLE_NAME: props.backend.events.tableName,
        TEAMS_TABLE_NAME: props.backend.teams.tableName,
        DEPLOYMENTS_TABLE_NAME: props.backend.deployments.tableName,
        COGNITO_ISSUER: issuer,
        COGNITO_CLIENT_ID: client.userPoolClientId,
        ALLOWED_ORIGINS: origins.join(","),
      },
    });
    apiHandler.addToRolePolicy(
      new PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem"],
        resources: [props.backend.events.tableArn, `${props.backend.events.tableArn}/index/GSI1`],
      }),
    );
    apiHandler.addToRolePolicy(
      new PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:DeleteItem"],
        resources: [props.backend.teams.tableArn],
      }),
    );
    apiHandler.addToRolePolicy(
      new PolicyStatement({
        actions: ["dynamodb:Query"],
        resources: [
          props.backend.deployments.tableArn,
          `${props.backend.deployments.tableArn}/index/GSI1`,
        ],
      }),
    );
    const api = new RestApi(this, "Api", {
      endpointTypes: [EndpointType.REGIONAL],
      deployOptions: { throttlingBurstLimit: 200, throttlingRateLimit: 100 },
      defaultCorsPreflightOptions: {
        allowOrigins: origins,
        allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowHeaders: ["Authorization", "Content-Type"],
      },
    });
    const authorizer = new CognitoUserPoolsAuthorizer(this, "OrganizerAuthorizer", {
      cognitoUserPools: [pool],
    });
    (authorizer.node.defaultChild as CfnAuthorizer).identityValidationExpression =
      `^${client.userPoolClientId}$`;
    const protectedMethod = { authorizationType: AuthorizationType.COGNITO, authorizer };
    const integration = new LambdaIntegration(apiHandler);
    const events = api.root.addResource("events");
    events.addMethod("GET", integration, protectedMethod);
    events.addMethod("POST", integration, protectedMethod);
    const event = events.addResource("{eventId}");
    event.addMethod("GET", integration, protectedMethod);
    const team = event.addResource("teams").addResource("{teamId}");
    team.addResource("rotate-login-key").addMethod("POST", integration, protectedMethod);
    team.addResource("access").addMethod("DELETE", integration, protectedMethod);
    const portal = api.root.addResource("portal");
    for (const path of ["me", "leaderboard"]) {
      const route = portal.addResource(path);
      // eslint-disable-next-line sonarjs/aws-apigateway-public-api -- These read-only routes verify the 256-bit team bearer in Lambda and derive event scope server-side; absent/revoked keys are tested.
      route.addMethod("GET", integration, { authorizationType: AuthorizationType.NONE });
    }
    new BucketDeployment(this, "ConsoleRuntime", {
      destinationBucket: consoleSite.bucket,
      distribution: consoleSite.distribution,
      sources: [
        Source.jsonData("runtime-config.json", {
          cognitoDomain: domain.baseUrl(),
          userClientId: client.userPoolClientId,
          apiUrl: api.url,
          // Fixed compatibility fields required by the existing SPA parser, never an authorization axis.
          tenantId: "local",
          tenantName: "TenkaCloud",
          eventLimits: CLOUD_EVENT_LIMITS,
          participantPortalUrl: props.backend.portal.url,
        }),
      ],
      prune: false,
    });
    new BucketDeployment(this, "PortalRuntime", {
      destinationBucket: props.backend.portal.bucket,
      distribution: props.backend.portal.distribution,
      sources: [
        Source.jsonData("runtime-config.json", {
          apiBaseUrl: api.url,
          eventTitle: "TenkaCloud",
          eventRegion: this.region,
          mode: "backend",
          cloudMode: "real",
          hasAws: false,
        }),
      ],
      prune: false,
    });
    scopeInvalidationPermissions(this, [
      consoleSite.distribution.distributionArn,
      props.backend.portal.distribution.distributionArn,
    ]);
    new CfnOutput(this, "ApplicationAdminConsoleUrl", { value: consoleSite.url });
    new CfnOutput(this, "OrganizerUserPoolId", { value: pool.userPoolId });
    new CfnOutput(this, "CognitoDomainUrl", { value: domain.baseUrl() });
    new CfnOutput(this, "ApiUrl", { value: api.url });
  }
}
