import { createHash } from "node:crypto";
import { join } from "node:path";
import { Aspects, CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import {
  AuthorizationType,
  type CfnAuthorizer,
  CognitoUserPoolsAuthorizer,
  EndpointType,
  Integration,
  IntegrationType,
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
import { CfnPermission, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";
import { DestroyPolicySetter } from "../cdk-aspect/destroy-policy-setter.js";
import { contentDigest } from "../problem-deploy/control-data/domain/deployment-work.js";
import {
  CLOUD_EVENT_LIMITS,
  SQL_EVENT_LIMITS,
} from "../problem-deploy/control-data/domain/events.js";
import {
  controlDataRuntimeEnv,
  grantTursoAuthTokenRead,
} from "../problem-deploy/control-data-backend-env.js";
import type { RunnerBinding } from "../problem-deploy/handlers/cloud-api/execution-config.js";
import { deploymentLogGroup } from "../utils/deployment-log-group.js";
import {
  CompetitorBootstrapHosting,
  competitorAssumeRolePolicy,
  denyControlPlaneAssumeRole,
  installationCompetitorConfig,
} from "./competitor-accounts.js";
import type { CloudDataStack } from "./data-stack.js";
import { CloudDeploymentPipeline } from "./deployment-pipeline.js";
import { cloudExecutionArtifacts } from "./execution-artifacts.js";
import { CloudHosting } from "./hosting.js";
import { scopeInvalidationPermissions } from "./invalidation-permissions.js";
import { cloudLambdaBundling } from "./lambda-bundling.js";
import { applyOwnershipTags } from "./ownership-tags.js";

export interface CloudApplicationStackProps extends StackProps {
  readonly repositoryRoot: string;
  readonly consoleAssets: string;
  readonly environment: string;
  readonly backend: CloudDataStack;
  /** Retained exact bindings for already-persisted legacy jobs; new onboarding uses the registry. */
  readonly runnerBindings?: readonly RunnerBinding[];
}
/** Restored single-installation Cognito/API/hosting composition, without SBT or tenant stack factories. */
export class CloudApplicationStack extends Stack {
  constructor(scope: Construct, id: string, props: CloudApplicationStackProps) {
    super(scope, id, props);
    applyOwnershipTags(this, props.environment);
    // Cover every CFN-owned resource, including the explicit deployment-provider logs.
    // Implicit S3 auto-delete provider logs are handled by stack-owned CLI cleanup.
    Aspects.of(this).add(new DestroyPolicySetter());
    const consoleSite = new CloudHosting(this, "OrganizerConsole", props.consoleAssets);
    const pool = new UserPool(this, "OrganizerUserPool", {
      removalPolicy: RemovalPolicy.DESTROY,
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
    const legacyBindings = props.runnerBindings ?? [];
    if (legacyBindings.some((binding) => binding.accountId === this.account))
      throw new Error("Control-plane account cannot host competitor resources.");
    const competitor = installationCompetitorConfig(this.account, this.region, props.environment);
    const bootstrapTemplate = new CompetitorBootstrapHosting(
      this,
      "CompetitorBootstrap",
      props.repositoryRoot,
    );
    const execution = cloudExecutionArtifacts(this, props.repositoryRoot, legacyBindings);
    const data = props.backend.controlData;
    const apiHandler = new NodejsFunction(this, "CloudApi", {
      runtime: Runtime.NODEJS_24_X,
      entry: join(
        props.repositoryRoot,
        "infrastructure/lib/problem-deploy/handlers/cloud-api/index.ts",
      ),
      handler: "handler",
      depsLockFilePath: join(props.repositoryRoot, "bun.lock"),
      projectRoot: props.repositoryRoot,
      timeout: Duration.seconds(28),
      memorySize: 512,
      role: apiRole,
      logGroup: apiLogs,
      bundling: cloudLambdaBundling(),
      environment: {
        ...controlDataRuntimeEnv(data),
        COGNITO_ISSUER: issuer,
        COGNITO_CLIENT_ID: client.userPoolClientId,
        ALLOWED_ORIGINS: origins.join(","),
        COMPETITOR_ROLE_NAME: competitor.roleName,
        COMPETITOR_EXTERNAL_ID_PARAMETER_ARN: competitor.externalIdParameterArn,
        CLOUD_ARTIFACT_BUCKET: execution.bucket.bucketName,
        CLOUD_CATALOG_KEY: execution.catalogKey,
        CLOUD_RUNNER_BINDINGS_KEY: execution.bindingsKey,
        CONTROL_PLANE_ACCOUNT: this.account,
      },
    });
    grantTursoAuthTokenRead(apiHandler, data);
    if (data.kind === "dynamodb") {
      apiHandler.addToRolePolicy(
        new PolicyStatement({
          actions: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem"],
          resources: [data.events.tableArn, `${data.events.tableArn}/index/GSI1`],
        }),
      );
      apiHandler.addToRolePolicy(
        new PolicyStatement({
          actions: [
            "dynamodb:GetItem",
            "dynamodb:Query",
            "dynamodb:PutItem",
            "dynamodb:DeleteItem",
          ],
          resources: [data.teams.tableArn],
        }),
      );
      apiHandler.addToRolePolicy(
        new PolicyStatement({
          actions: ["dynamodb:Query"],
          resources: [data.deployments.tableArn, `${data.deployments.tableArn}/index/GSI1`],
        }),
      );
      apiHandler.addToRolePolicy(
        new PolicyStatement({
          actions: ["dynamodb:ConditionCheckItem"],
          resources: [data.events.tableArn],
        }),
      );
      // Only a missing first-use ExternalId needs authoritative checks of retained registry/job references.
      apiHandler.addToRolePolicy(
        new PolicyStatement({
          actions: ["dynamodb:Scan"],
          resources: [data.events.tableArn, data.deployments.tableArn],
        }),
      );
    }
    apiHandler.addToRolePolicy(competitorAssumeRolePolicy(competitor));
    apiHandler.addToRolePolicy(
      new PolicyStatement({
        actions: ["sts:AssumeRole"],
        // Generated physical role names are deliberately not guessed. Runtime additionally
        // binds DescribeStackResource's exact viewer to the original stack/attempt.
        resources: ["arn:aws:iam::*:role/*"],
        conditions: {
          StringEquals: {
            "aws:ResourceTag/TenkaCloud:Purpose": "participant-viewer",
            "aws:ResourceTag/TenkaCloud:ProblemId": "hello-world",
            "aws:ResourceTag/TenkaCloud:OperatorAccount": this.account,
            // biome-ignore lint/suspicious/noTemplateCurlyInString: IAM resolves this resource-tag policy variable, not JavaScript.
            "sts:ExternalId": "${aws:ResourceTag/TenkaCloud:JobId}",
          },
          ArnLike: {
            "aws:ResourceTag/TenkaCloud:StackId": "arn:aws:cloudformation:*:*:stack/tc-cloud-*/*",
          },
          Null: { "sts:ExternalId": "false", "aws:ResourceTag/TenkaCloud:JobId": "false" },
        },
      }),
    );
    apiHandler.addToRolePolicy(denyControlPlaneAssumeRole(this.account));
    apiHandler.addToRolePolicy(
      new PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [competitor.externalIdParameterArn],
      }),
    );
    apiHandler.addToRolePolicy(
      new PolicyStatement({
        actions: ["ssm:PutParameter"],
        resources: [competitor.externalIdParameterArn],
        conditions: { StringEquals: { "ssm:Overwrite": "false" } },
      }),
    );
    apiHandler.node.addDependency(execution.deployment);
    if (data.kind === "dynamodb") {
      apiHandler.addToRolePolicy(
        new PolicyStatement({
          actions: ["dynamodb:DeleteItem"],
          resources: [data.events.tableArn],
        }),
      );
      apiHandler.addToRolePolicy(
        new PolicyStatement({
          actions: [
            "dynamodb:GetItem",
            "dynamodb:Query",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:ConditionCheckItem",
          ],
          resources: [data.events.tableArn, data.teams.tableArn, data.deployments.tableArn],
        }),
      );
      apiHandler.addToRolePolicy(
        new PolicyStatement({
          actions: ["dynamodb:DeleteItem"],
          resources: [data.deployments.tableArn],
        }),
      );
    }
    apiHandler.addToRolePolicy(
      new PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [
          execution.bucket.arnForObjects(execution.catalogKey),
          execution.bucket.arnForObjects(execution.pluginKey),
          execution.bucket.arnForObjects(execution.bindingsKey),
        ],
      }),
    );
    if (legacyBindings.length) {
      apiHandler.addToRolePolicy(
        new PolicyStatement({
          actions: ["sts:AssumeRole"],
          resources: [...new Set(legacyBindings.map((binding) => binding.roleArn))],
        }),
      );
      apiHandler.addToRolePolicy(
        new PolicyStatement({
          actions: ["ssm:GetParameter"],
          resources: [...new Set(legacyBindings.map((binding) => binding.externalIdParameterArn))],
        }),
      );
    }
    const pipeline = new CloudDeploymentPipeline(this, "DeploymentPipeline", {
      repositoryRoot: props.repositoryRoot,
      controlData: data,
      allowedRoleArns: [...new Set(legacyBindings.map((binding) => binding.roleArn))],
      externalIdParameterArns: [
        ...new Set(legacyBindings.map((binding) => binding.externalIdParameterArn)),
      ],
      runnerBindings: legacyBindings,
      competitorConfig: competitor,
      catalogBucket: execution.bucket,
      catalogKey: execution.catalogKey,
      bindingsKey: execution.bindingsKey,
    });
    new CfnOutput(this, "CloudExecutionArtifactBucket", { value: execution.bucket.bucketName });
    new CfnOutput(this, "CloudExecutionCatalogKey", { value: execution.catalogKey });
    new CfnOutput(this, "CloudDeploymentStateMachineArn", {
      value: pipeline.stateMachine.stateMachineArn,
    });
    const api = new RestApi(this, "Api", {
      // No API execution/access logs are configured; avoid changing the regional logging role.
      cloudWatchRole: false,
      endpointTypes: [EndpointType.REGIONAL],
      deployOptions: { throttlingBurstLimit: 200, throttlingRateLimit: 100 },
      defaultCorsPreflightOptions: {
        allowOrigins: origins,
        allowMethods: ["GET", "POST", "DELETE", "PATCH", "OPTIONS"],
        allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
      },
    });
    const authorizer = new CognitoUserPoolsAuthorizer(this, "OrganizerAuthorizer", {
      cognitoUserPools: [pool],
    });
    (authorizer.node.defaultChild as CfnAuthorizer).identityValidationExpression =
      `^${client.userPoolClientId}$`;
    const protectedMethod = { authorizationType: AuthorizationType.COGNITO, authorizer };
    // Restore #2947's bounded API grants, preserving deployed and console-test invocation without per-route statements.
    for (const [id, stage] of [
      ["CloudApiInvoke", api.deploymentStage.stageName],
      ["CloudApiTestInvoke", "test-invoke-stage"],
    ] as const) {
      new CfnPermission(this, id, {
        action: "lambda:InvokeFunction",
        functionName: apiHandler.functionArn,
        principal: "apigateway.amazonaws.com",
        sourceAccount: this.account,
        sourceArn: api.arnForExecuteApi("*", "/*", stage),
      });
    }
    const integration = new Integration({
      type: IntegrationType.AWS_PROXY,
      integrationHttpMethod: "POST",
      uri: `arn:${this.partition}:apigateway:${this.region}:lambda:path/2015-03-31/functions/${apiHandler.functionArn}/invocations`,
    });
    const events = api.root.addResource("events");
    events.addMethod("GET", integration, protectedMethod);
    events.addMethod("POST", integration, protectedMethod);
    const event = events.addResource("{eventId}");
    event.addMethod("GET", integration, protectedMethod);
    event
      .addResource("problems")
      .addResource("{problemId}")
      .addResource("coordination")
      .addResource("reset")
      .addMethod("POST", integration, protectedMethod);
    const team = event.addResource("teams").addResource("{teamId}");
    team.addResource("rotate-login-key").addMethod("POST", integration, protectedMethod);
    team.addResource("access").addMethod("DELETE", integration, protectedMethod);
    const portal = api.root.addResource("portal");
    for (const path of ["me", "leaderboard"]) {
      const route = portal.addResource(path);
      // eslint-disable-next-line sonarjs/aws-apigateway-public-api -- These read-only routes verify the 256-bit team bearer in Lambda and derive event scope server-side; absent/revoked keys are tested.
      route.addMethod("GET", integration, { authorizationType: AuthorizationType.NONE });
    }
    const coordination = portal.getResource("me")?.addResource("coordination");
    if (!coordination) throw new Error("Participant coordination route is missing.");
    const projection = coordination.addResource("projection");
    // eslint-disable-next-line sonarjs/aws-apigateway-public-api -- Native requests revalidate bearer, event clock, authVersion and installation fences inside the state/score transaction.
    projection.addMethod("GET", integration, { authorizationType: AuthorizationType.NONE });
    const operation = coordination.addResource("op");
    // eslint-disable-next-line sonarjs/aws-apigateway-public-api -- Every operation is authenticated and idempotent in the same atomic native state/score transaction.
    operation.addMethod("POST", integration, { authorizationType: AuthorizationType.NONE });
    const accounts = api.root.addResource("admin").addResource("competitor-accounts");
    accounts.addMethod("GET", integration, protectedMethod);
    accounts.addMethod("POST", integration, protectedMethod);
    accounts.addResource("bulk").addMethod("POST", integration, protectedMethod);
    const account = accounts.addResource("{awsAccountId}");
    account.addMethod("DELETE", integration, protectedMethod);
    account.addResource("verify").addMethod("POST", integration, protectedMethod);
    event.addResource("deploy").addMethod("POST", integration, protectedMethod);
    event.addMethod("DELETE", integration, protectedMethod);
    event.addResource("schedule").addMethod("PATCH", integration, protectedMethod);
    event.addResource("end").addMethod("POST", integration, protectedMethod);
    const scoringLock = event.addResource("lock-scoring");
    scoringLock.addMethod("POST", integration, protectedMethod);
    scoringLock.addMethod("DELETE", integration, protectedMethod);
    team.addResource("connection").addMethod("POST", integration, protectedMethod);
    const history = portal.getResource("me")?.addResource("score-events");
    if (!history) throw new Error("Participant history route is missing.");
    // eslint-disable-next-line sonarjs/aws-apigateway-public-api -- Fresh team bearer authentication derives the history partition; request-supplied team/event identifiers are not accepted.
    history.addMethod("GET", integration, { authorizationType: AuthorizationType.NONE });
    const flag = portal.getResource("me")?.addResource("submit-flag");
    if (!flag) throw new Error("Participant route is missing.");
    // eslint-disable-next-line sonarjs/aws-apigateway-public-api -- The Lambda revalidates the team bearer, event/attempt ownership and current authVersion in the scoring transaction; no Cognito participant identity exists.
    flag.addMethod("POST", integration, { authorizationType: AuthorizationType.NONE });
    for (const route of ["cli-credentials", "console-signin-url"]) {
      const access = portal.getResource("me")?.addResource(route);
      if (!access) throw new Error("Participant access route is missing.");
      // eslint-disable-next-line sonarjs/aws-apigateway-public-api -- Fresh team/event/attempt/connection checks guard CLI issuance; the unsupported console route never issues credentials.
      access.addMethod("GET", integration, { authorizationType: AuthorizationType.NONE });
    }
    const consoleRuntime = new BucketDeployment(this, "ConsoleRuntime", {
      logGroup: deploymentLogGroup(this),
      destinationBucket: consoleSite.bucket,
      distribution: consoleSite.distribution,
      sources: [
        Source.jsonData("runtime-config.json", {
          cognitoDomain: domain.baseUrl(),
          mode: "cloud-host",
          supportedProblemIds: execution.problemIds,
          nativeProblemIds: execution.nativeProblemIds,
          features: {
            samlSso: false,
            nonAwsRuntime: false,
            redTeam: false,
            challengePrerequisiteGate: false,
          },
          userClientId: client.userPoolClientId,
          apiUrl: api.url,
          // Fixed compatibility fields required by the existing SPA parser, never an authorization axis.
          tenantId: "local",
          tenantName: "TenkaCloud",
          eventLimits: data.kind === "turso" ? SQL_EVENT_LIMITS : CLOUD_EVENT_LIMITS,
          competitorRoleName: competitor.roleName,
          competitorBootstrapTemplateUrl: bootstrapTemplate.templateUrl,
          participantPortalUrl: props.backend.portal.url,
        }),
      ],
      prune: false,
    });
    consoleRuntime.node.addDependency(consoleSite.bucket);
    const portalRuntime = new BucketDeployment(this, "PortalRuntime", {
      logGroup: deploymentLogGroup(this),
      destinationBucket: props.backend.portal.bucket,
      distribution: props.backend.portal.distribution,
      sources: [
        Source.jsonData("runtime-config.json", {
          apiBaseUrl: api.url,
          eventTitle: "TenkaCloud",
          eventRegion: this.region,
          mode: "backend",
          cloudMode: "real",
          hasAws: true,
          notificationsEnabled: false,
          scoreTimelineEnabled: false,
        }),
      ],
      prune: false,
    });
    portalRuntime.node.addDependency(props.backend.portal.bucket);
    scopeInvalidationPermissions(this, [
      consoleSite.distribution.distributionArn,
      props.backend.portal.distribution.distributionArn,
    ]);
    new CfnOutput(this, "ApplicationAdminConsoleUrl", { value: consoleSite.url });
    new CfnOutput(this, "OrganizerUserPoolId", { value: pool.userPoolId });
    new CfnOutput(this, "CognitoDomainUrl", { value: domain.baseUrl() });
    new CfnOutput(this, "ApiUrl", { value: api.url });
    new CfnOutput(this, "CloudRunnerEnabled", { value: "true" });
    new CfnOutput(this, "CloudInstallationControlVersion", { value: "2" });
    new CfnOutput(this, "CloudRunnerMode", {
      value: legacyBindings.length ? "registry-with-legacy-bindings" : "registry",
    });
    new CfnOutput(this, "CloudLegacyBindingsDigest", {
      value: contentDigest(JSON.stringify(legacyBindings)),
    });
    new CfnOutput(this, "CompetitorRoleName", { value: competitor.roleName });
    new CfnOutput(this, "CompetitorExternalIdParameterArn", {
      value: competitor.externalIdParameterArn,
    });
  }
}
