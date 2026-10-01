import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { projectBootstrap } from "./bootstrap.js";
import { installationCompetitorConfig } from "./competitor-accounts.js";
import { assertCommercialRegion } from "./regions.js";
import { cloudStackNames, cloudStackTags } from "./stack-names.js";

export interface DeploymentPolicyScope {
  readonly account: string;
  readonly region: string;
  readonly environment: string;
  /** Exact retained legacy bindings, when the installation still has historical jobs. */
  readonly runnerBindings?: readonly {
    readonly roleArn: string;
    readonly externalIdParameterArn: string;
  }[];
}
export interface IamStatement {
  readonly Sid: string;
  readonly Effect: "Allow" | "Deny";
  readonly Action: readonly string[];
  readonly Resource: readonly string[];
  readonly Condition?: Record<string, Record<string, string | readonly string[]>>;
}
export interface IamPolicyDocument {
  readonly Version: "2012-10-17";
  readonly Statement: readonly IamStatement[];
}

/** Adding a new resource type requires reviewing its deployment permissions, not a service wildcard. */
export const CLOUD_HOSTING_RESOURCE_TYPES = [
  "AWS::ApiGateway::Authorizer",
  "AWS::ApiGateway::Deployment",
  "AWS::ApiGateway::Method",
  "AWS::ApiGateway::Resource",
  "AWS::ApiGateway::RestApi",
  "AWS::ApiGateway::Stage",
  "AWS::CloudFront::Distribution",
  "AWS::CloudFront::OriginAccessControl",
  "AWS::Cognito::UserPool",
  "AWS::Cognito::UserPoolClient",
  "AWS::Cognito::UserPoolDomain",
  "AWS::DynamoDB::Table",
  "AWS::Events::Rule",
  "AWS::IAM::Policy",
  "AWS::IAM::Role",
  "AWS::Lambda::Function",
  "AWS::Lambda::LayerVersion",
  "AWS::Lambda::Permission",
  "AWS::Logs::LogGroup",
  "AWS::S3::Bucket",
  "AWS::S3::BucketPolicy",
  "AWS::StepFunctions::StateMachine",
  "Custom::CDKBucketDeployment",
  "Custom::S3AutoDeleteObjects",
] as const;

/** These are deliberate residual privileges, not claims of complete account isolation. */
export const DEPLOYMENT_POLICY_LIMITS = [
  "CloudFormation deployment can change application code, data, identity configuration and inline role policies. Treat deployers as installation administrators.",
  "CloudFront origin access controls have generated IDs and no tag authorization; their lifecycle is account-scoped. Distribution lifecycle uses ownership tags.",
  "CloudWatch log delivery and resource-policy APIs, CloudFormation validation/list exports, Cognito domain discovery and create operations without resource ARNs require Resource '*'. Regional APIs are region-conditioned.",
  "S3 bucket ABAC is not enabled. Bucket access and tagless layer/log resources use the stable tenkacloud-cloud-* project namespace because CloudFormation truncates long names. This permits access across this project's environments, within the stated account/region constraints.",
  "PassRole uses the owning account's tenkacloud-cloud-* role namespace and only Lambda/Step Functions. IAM does not reliably support resource-tag conditions for PassRole; this is project-wide access across environments, not an isolation boundary against another project deployer.",
  "The application boundary must be applied to every application/data IAM role, including CDK custom-resource providers. Bootstrap execution has no permission to remove or edit that boundary.",
  "The pinned standard CDK bootstrap resources and outputs are retained, but generic context lookups, cross-account trust, customer-managed asset KMS keys and the shared/default CDKToolkit are unsupported. Ordinary deployment can assume only the file publisher, scoped deployer and minimal lookup role.",
] as const;

const allow = (
  Sid: string,
  Action: readonly string[],
  Resource: readonly string[],
  Condition?: IamStatement["Condition"],
): IamStatement => ({
  Sid,
  Effect: "Allow",
  Action,
  Resource,
  ...(Condition ? { Condition } : {}),
});
const document = (Statement: readonly IamStatement[]): IamPolicyDocument => ({
  Version: "2012-10-17",
  Statement,
});
const CFN_READ = [
  "cloudformation:DescribeStacks",
  "cloudformation:DescribeStackEvents",
  "cloudformation:DescribeStackResource",
  "cloudformation:DescribeStackResources",
  "cloudformation:ListStackResources",
  "cloudformation:GetTemplate",
  "cloudformation:GetTemplateSummary",
  "cloudformation:DescribeChangeSet",
  "cloudformation:ListChangeSets",
];
const CFN_WRITE_WITH_ROLE = [
  "cloudformation:CreateStack",
  "cloudformation:UpdateStack",
  "cloudformation:CreateChangeSet",
  "cloudformation:DeleteStack",
  "cloudformation:ContinueUpdateRollback",
  "cloudformation:RollbackStack",
];
const CFN_WRITE = [
  "cloudformation:ExecuteChangeSet",
  "cloudformation:DeleteChangeSet",
  "cloudformation:CancelUpdateStack",
  "cloudformation:UpdateTerminationProtection",
];
const CFN_TAG_ACTIONS = ["cloudformation:TagResource", "cloudformation:UntagResource"];
const CFN_TAG_CONDITION = {
  StringEquals: {
    "cloudformation:CreateAction": [
      "CreateStack",
      "UpdateStack",
      "CreateChangeSet",
      "ExecuteChangeSet",
    ],
  },
};
const S3_BUCKET = [
  "s3:CreateBucket",
  "s3:DeleteBucket",
  "s3:GetBucketLocation",
  "s3:GetBucketAcl",
  "s3:PutBucketAcl",
  "s3:GetBucketPolicy",
  "s3:PutBucketPolicy",
  "s3:DeleteBucketPolicy",
  "s3:GetBucketPolicyStatus",
  "s3:GetBucketPublicAccessBlock",
  "s3:PutBucketPublicAccessBlock",
  "s3:GetEncryptionConfiguration",
  "s3:PutEncryptionConfiguration",
  "s3:GetBucketTagging",
  "s3:PutBucketTagging",
  "s3:GetBucketVersioning",
  "s3:PutBucketVersioning",
  "s3:GetLifecycleConfiguration",
  "s3:PutLifecycleConfiguration",
  "s3:GetBucketOwnershipControls",
  "s3:PutBucketOwnershipControls",
  "s3:ListBucket",
  "s3:ListBucketVersions",
  "s3:ListBucketMultipartUploads",
];
const LOG_DELIVERY = [
  "logs:CreateLogDelivery",
  "logs:GetLogDelivery",
  "logs:UpdateLogDelivery",
  "logs:DeleteLogDelivery",
  "logs:ListLogDeliveries",
  "logs:PutResourcePolicy",
  "logs:DescribeResourcePolicies",
  "logs:DescribeLogGroups",
];
const ROLE_READ = [
  "iam:GetRole",
  "iam:GetRolePolicy",
  "iam:ListRolePolicies",
  "iam:ListAttachedRolePolicies",
  "iam:ListRoleTags",
];
const ROLE_WRITE = [
  "iam:DeleteRole",
  "iam:UpdateRole",
  "iam:UpdateAssumeRolePolicy",
  "iam:PutRolePolicy",
  "iam:DeleteRolePolicy",
  "iam:TagRole",
  "iam:UntagRole",
];
const BASIC_ROLE_POLICIES = ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"];

function scopeResources(scope: DeploymentPolicyScope) {
  if (!/^\d{12}$/u.test(scope.account))
    throw new Error("A 12-digit deployment account is required.");
  assertCommercialRegion(scope.region);
  const names = cloudStackNames(scope.environment);
  const toolkit = projectBootstrap(scope.environment);
  const { account, region } = scope;
  for (const binding of scope.runnerBindings ?? []) {
    if (
      !/^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/u.test(binding.roleArn) ||
      binding.roleArn.startsWith(`arn:aws:iam::${account}:`) ||
      !/^arn:aws:ssm:[a-z0-9-]+:\d{12}:parameter\/[\w./-]+$/u.test(binding.externalIdParameterArn)
    ) {
      throw new Error(
        "Deployment policy legacy bindings require exact competitor role and parameter ARNs.",
      );
    }
  }
  const regional = (service: string, resource: string) =>
    `arn:aws:${service}:${region}:${account}:${resource}`;
  const stackNames = [names.app, names.backend];
  const stackArns = stackNames.map((name) => regional("cloudformation", `stack/${name}/*`));
  // CloudFormation shortens long physical names. Keep the stable project prefix;
  // tag-capable services additionally require ownership and region tags.
  const roleArns = [`arn:aws:iam::${account}:role/tenkacloud-cloud-*`];
  const bucketArns = ["arn:aws:s3:::tenkacloud-cloud-*"];
  const tagCondition = {
    StringEquals: Object.fromEntries(
      Object.entries({ ...cloudStackTags(scope.environment), TenkaCloudRegion: region }).map(
        ([key, value]) => [`aws:ResourceTag/${key}`, value],
      ),
    ),
  };
  const requestTags = {
    StringEquals: Object.fromEntries(
      Object.entries({ ...cloudStackTags(scope.environment), TenkaCloudRegion: region }).map(
        ([key, value]) => [`aws:RequestTag/${key}`, value],
      ),
    ),
  };
  const inRegion = { StringEquals: { "aws:RequestedRegion": region } };
  const bucketLocation: IamStatement["Condition"] = {
    [region === "us-east-1" ? "StringEqualsIfExists" : "StringEquals"]: {
      "s3:LocationConstraint": region,
    },
  };
  const roleName = (kind: string) => `cdk-${toolkit.qualifier}-${kind}-role-${account}-${region}`;
  const bootstrapRole = (kind: string) => `arn:aws:iam::${account}:role/${roleName(kind)}`;
  const policyPrefix = `arn:aws:iam::${account}:policy/tenkacloud/cloud-hosting/${scope.environment}-${region}`;
  const assetBucketName = `cdk-${toolkit.qualifier}-assets-${account}-${region}`;
  const identities = {
    setupStackName: toolkit.stackName,
    qualifier: toolkit.qualifier,
    executionRoleArn: bootstrapRole("cfn-exec"),
    deployRoleArn: bootstrapRole("deploy"),
    filePublishingRoleArn: bootstrapRole("file-publishing"),
    lookupRoleArn: bootstrapRole("lookup"),
    imagePublishingRoleArn: bootstrapRole("image-publishing"),
    applicationBoundaryArn: `${policyPrefix}-application-boundary`,
    operatorPolicyArn: `${policyPrefix}-operator`,
    assetBucketName,
  };
  return {
    regional,
    stackArns,
    roleArns,
    bucketArns,
    tagCondition,
    requestTags,
    inRegion,
    bucketLocation,
    identities,
    policyPrefix,
    roleName,
    versionArn: regional("ssm", `parameter/cdk-bootstrap/${toolkit.qualifier}/version`),
  };
}

/** Split only at statement boundaries; IAM managed policies are limited to 6,144 characters. */
export function splitManagedPolicy(policy: IamPolicyDocument): IamPolicyDocument[] {
  const parts: IamPolicyDocument[] = [];
  let current: IamStatement[] = [];
  for (const statement of policy.Statement) {
    if (JSON.stringify(document([statement])).length > 6144)
      throw new Error(`IAM statement ${statement.Sid} exceeds the managed policy limit.`);
    if (JSON.stringify(document([...current, statement])).length > 6144) {
      parts.push(document(current));
      current = [];
    }
    current.push(statement);
  }
  if (current.length) parts.push(document(current));
  return parts;
}

/** Pure, reviewable JSON. No credentials, AWS calls, filesystem or policy-name overrides. */
export function deploymentPolicies(scope: DeploymentPolicyScope) {
  const r = scopeResources(scope);
  const { account, region } = scope;
  const { regional, tagCondition, requestTags, inRegion } = r;
  const assetArn = `arn:aws:s3:::${r.identities.assetBucketName}`;
  const functions = [regional("lambda", "function:*")];
  const tables = [regional("dynamodb", "table/*")];
  const pools = [regional("cognito-idp", `userpool/${region}_*`)];
  const distributions = [`arn:aws:cloudfront::${account}:distribution/*`];
  const roleTags = {
    StringEquals: { ...tagCondition.StringEquals, "aws:ResourceTag/TenkaCloudRegion": region },
  };
  const execution = document([
    allow(
      "CreateTables",
      ["dynamodb:CreateTable"],
      [regional("dynamodb", "table/tenkacloud-cloud-*")],
      requestTags,
    ),
    allow(
      "Tables",
      [
        "dynamodb:DeleteTable",
        "dynamodb:UpdateTable",
        "dynamodb:DescribeTable",
        "dynamodb:DescribeContinuousBackups",
        "dynamodb:UpdateContinuousBackups",
        "dynamodb:DescribeTimeToLive",
        "dynamodb:UpdateTimeToLive",
        "dynamodb:ListTagsOfResource",
        "dynamodb:TagResource",
        "dynamodb:UntagResource",
      ],
      [regional("dynamodb", "table/tenkacloud-cloud-*")],
      tagCondition,
    ),
    allow("CreatePool", ["cognito-idp:CreateUserPool"], ["*"], {
      StringEquals: { ...requestTags.StringEquals, "aws:RequestedRegion": region },
    }),
    allow(
      "Pools",
      [
        "cognito-idp:DeleteUserPool",
        "cognito-idp:DescribeUserPool",
        "cognito-idp:UpdateUserPool",
        "cognito-idp:AddCustomAttributes",
        "cognito-idp:GetUserPoolMfaConfig",
        "cognito-idp:SetUserPoolMfaConfig",
        "cognito-idp:CreateUserPoolClient",
        "cognito-idp:DescribeUserPoolClient",
        "cognito-idp:UpdateUserPoolClient",
        "cognito-idp:DeleteUserPoolClient",
        "cognito-idp:CreateUserPoolDomain",
        "cognito-idp:UpdateUserPoolDomain",
        "cognito-idp:DeleteUserPoolDomain",
        "cognito-idp:ListTagsForResource",
        "cognito-idp:TagResource",
        "cognito-idp:UntagResource",
      ],
      pools,
      tagCondition,
    ),
    allow("DomainDiscovery", ["cognito-idp:DescribeUserPoolDomain"], ["*"], inRegion),
    allow(
      "Buckets",
      S3_BUCKET.filter((action) => action !== "s3:CreateBucket"),
      r.bucketArns,
      { StringEquals: { "s3:ResourceAccount": account } },
    ),
    allow("CreateBuckets", ["s3:CreateBucket"], r.bucketArns, r.bucketLocation),
    allow("ReadFileAssets", ["s3:GetObject", "s3:GetObjectVersion"], [`${assetArn}/*`]),
    allow("ReadAssetBucket", ["s3:GetBucketLocation", "s3:ListBucket"], [assetArn]),
    allow("CreateDistribution", ["cloudfront:CreateDistribution"], ["*"], requestTags),
    allow(
      "Distributions",
      [
        "cloudfront:GetDistribution",
        "cloudfront:GetDistributionConfig",
        "cloudfront:UpdateDistribution",
        "cloudfront:DeleteDistribution",
        "cloudfront:TagResource",
        "cloudfront:UntagResource",
        "cloudfront:ListTagsForResource",
      ],
      distributions,
      tagCondition,
    ),
    allow("CreateOriginAccessControl", ["cloudfront:CreateOriginAccessControl"], ["*"]),
    allow(
      "OriginAccessControls",
      [
        "cloudfront:GetOriginAccessControl",
        "cloudfront:GetOriginAccessControlConfig",
        "cloudfront:UpdateOriginAccessControl",
        "cloudfront:DeleteOriginAccessControl",
      ],
      [`arn:aws:cloudfront::${account}:origin-access-control/*`],
    ),
    // REST child resources inherit the parent REST API's authorization tags.
    allow(
      "CreateRestApi",
      ["apigateway:POST"],
      [`arn:aws:apigateway:${region}::/restapis`],
      requestTags,
    ),
    allow(
      "RestApiResources",
      [
        "apigateway:GET",
        "apigateway:POST",
        "apigateway:PUT",
        "apigateway:PATCH",
        "apigateway:DELETE",
      ],
      [`arn:aws:apigateway:${region}::/restapis/*`, `arn:aws:apigateway:${region}::/tags/*`],
      tagCondition,
    ),
    allow("CreateFunctions", ["lambda:CreateFunction"], functions, requestTags),
    allow(
      "Functions",
      [
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:GetPolicy",
        "lambda:GetFunctionConcurrency",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:DeleteFunction",
        "lambda:AddPermission",
        "lambda:RemovePermission",
        "lambda:PutFunctionConcurrency",
        "lambda:DeleteFunctionConcurrency",
        "lambda:ListTags",
        "lambda:TagResource",
        "lambda:UntagResource",
        "lambda:InvokeFunction",
      ],
      functions,
      tagCondition,
    ),
    allow(
      "Layers",
      ["lambda:PublishLayerVersion", "lambda:GetLayerVersion", "lambda:DeleteLayerVersion"],
      [
        regional("lambda", "layer:tenkacloud-cloud-*"),
        regional("lambda", "layer:tenkacloud-cloud-*:*"),
      ],
    ),
    allow("CreateRolesWithBoundary", ["iam:CreateRole"], r.roleArns, {
      StringEquals: {
        ...requestTags.StringEquals,
        "aws:RequestTag/TenkaCloudRegion": region,
        "iam:PermissionsBoundary": r.identities.applicationBoundaryArn,
      },
    }),
    allow("ReadRoles", ROLE_READ, r.roleArns, roleTags),
    allow("ApplicationRoles", ROLE_WRITE, r.roleArns, roleTags),
    allow("ApplyApplicationBoundary", ["iam:PutRolePermissionsBoundary"], r.roleArns, {
      StringEquals: {
        ...roleTags.StringEquals,
        "iam:PermissionsBoundary": r.identities.applicationBoundaryArn,
      },
    }),
    allow(
      "AttachServiceLoggingPolicies",
      ["iam:AttachRolePolicy", "iam:DetachRolePolicy"],
      r.roleArns,
      { StringEquals: roleTags.StringEquals, ArnEquals: { "iam:PolicyARN": BASIC_ROLE_POLICIES } },
    ),
    allow("ReadLoggingPolicies", ["iam:GetPolicy", "iam:GetPolicyVersion"], BASIC_ROLE_POLICIES),
    allow("PassApplicationRoles", ["iam:PassRole"], r.roleArns, {
      StringEquals: {
        "iam:PassedToService": ["lambda.amazonaws.com", "states.amazonaws.com"],
      },
    }),
    allow(
      "CreateLogGroups",
      ["logs:CreateLogGroup"],
      [
        regional("logs", "log-group:tenkacloud-cloud-*"),
        regional("logs", "log-group:/aws/lambda/tenkacloud-cloud-*"),
      ],
      requestTags,
    ),
    allow(
      "LogGroups",
      [
        "logs:DeleteLogGroup",
        "logs:PutRetentionPolicy",
        "logs:DeleteRetentionPolicy",
        "logs:ListTagsForResource",
        "logs:ListTagsLogGroup",
        "logs:TagResource",
        "logs:UntagResource",
        "logs:TagLogGroup",
        "logs:UntagLogGroup",
      ],
      [
        regional("logs", "log-group:tenkacloud-cloud-*"),
        regional("logs", "log-group:/aws/lambda/tenkacloud-cloud-*"),
      ],
      tagCondition,
    ),
    allow("WorkflowLogDelivery", LOG_DELIVERY, ["*"], inRegion),
    allow(
      "CreateWorkflows",
      ["states:CreateStateMachine"],
      [regional("states", "stateMachine:*")],
      requestTags,
    ),
    allow(
      "Workflows",
      [
        "states:DescribeStateMachine",
        "states:UpdateStateMachine",
        "states:DeleteStateMachine",
        "states:TagResource",
        "states:UntagResource",
        "states:ListTagsForResource",
      ],
      [regional("states", "stateMachine:*")],
      tagCondition,
    ),
    allow(
      "CreateRules",
      ["events:PutRule"],
      [regional("events", "rule/tenkacloud-cloud-*")],
      requestTags,
    ),
    allow(
      "Rules",
      [
        "events:PutRule",
        "events:DeleteRule",
        "events:DescribeRule",
        "events:EnableRule",
        "events:DisableRule",
        "events:PutTargets",
        "events:RemoveTargets",
        "events:ListTargetsByRule",
        "events:ListTagsForResource",
        "events:TagResource",
        "events:UntagResource",
      ],
      [regional("events", "rule/tenkacloud-cloud-*")],
      tagCondition,
    ),
  ]);
  const operator = document([
    allow("CallerIdentity", ["sts:GetCallerIdentity"], ["*"]),
    allow("ReadOwnedStacks", CFN_READ, [
      ...r.stackArns,
      regional("cloudformation", `stack/${r.identities.setupStackName}/*`),
    ]),
    allow("DeployWithExecutionRole", CFN_WRITE_WITH_ROLE, r.stackArns, {
      ArnEquals: { "cloudformation:RoleArn": r.identities.executionRoleArn },
    }),
    allow("OwnedStackChanges", CFN_WRITE, r.stackArns),
    allow("OwnedStackTags", CFN_TAG_ACTIONS, r.stackArns, CFN_TAG_CONDITION),
    allow(
      "ValidateAndResolveExports",
      ["cloudformation:ValidateTemplate", "cloudformation:ListExports"],
      ["*"],
      inRegion,
    ),
    allow("PassCloudFormationExecution", ["iam:PassRole"], [r.identities.executionRoleArn], {
      StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" },
    }),
    allow(
      "AssumeOwnedBootstrapRoles",
      ["sts:AssumeRole", "sts:TagSession"],
      [r.identities.deployRoleArn, r.identities.filePublishingRoleArn, r.identities.lookupRoleArn],
    ),
    allow("BootstrapVersion", ["ssm:GetParameter", "ssm:GetParameters"], [r.versionArn]),
    allow(
      "AssetBucketMetadata",
      [
        "s3:GetBucketLocation",
        "s3:GetBucketVersioning",
        "s3:GetEncryptionConfiguration",
        "s3:ListBucket",
      ],
      [assetArn],
    ),
    allow(
      "FileAssets",
      [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:PutObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts",
      ],
      [`${assetArn}/*`],
    ),
    allow(
      "NativeClosureArtifacts",
      ["s3:GetObject"],
      r.bucketArns.flatMap((arn) => [`${arn}/catalogs/*`, `${arn}/plugins/*`]),
      { StringEquals: { "s3:ResourceAccount": account } },
    ),
    allow(
      "OrganizerFirstLogin",
      ["cognito-idp:AdminGetUser", "cognito-idp:AdminCreateUser"],
      pools,
      tagCondition,
    ),
    // The CLI fences/drains persisted work before teardown; it never assumes competitor roles.
    allow(
      "InstallationRecords",
      [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:ConditionCheckItem",
      ],
      tables,
      tagCondition,
    ),
  ]);
  const applicationBoundary = applicationRoleBoundary(scope);
  const executionParts = splitManagedPolicy(execution);
  const executionPolicyArns = executionParts.map(
    (_, index) => `${r.policyPrefix}-execution-${index + 1}`,
  );
  const identities = {
    ...r.identities,
    executionPolicyArn: executionPolicyArns[0] as string,
    executionPolicyArns,
  };
  const setup = document([
    allow("CallerIdentity", ["sts:GetCallerIdentity"], ["*"]),
    allow(
      "OwnedToolkit",
      [...CFN_READ, ...CFN_WRITE_WITH_ROLE, ...CFN_WRITE],
      [regional("cloudformation", `stack/${identities.setupStackName}/*`)],
    ),
    allow(
      "ToolkitTags",
      CFN_TAG_ACTIONS,
      [regional("cloudformation", `stack/${identities.setupStackName}/*`)],
      CFN_TAG_CONDITION,
    ),
    allow("ValidateTemplate", ["cloudformation:ValidateTemplate"], ["*"], inRegion),
    allow(
      "ToolkitRoles",
      [...ROLE_READ, ...ROLE_WRITE, "iam:CreateRole"],
      [
        identities.executionRoleArn,
        identities.deployRoleArn,
        identities.filePublishingRoleArn,
        identities.imagePublishingRoleArn,
        identities.lookupRoleArn,
      ],
    ),
    allow(
      "ToolkitPolicies",
      [
        "iam:CreatePolicy",
        "iam:DeletePolicy",
        "iam:GetPolicy",
        "iam:GetPolicyVersion",
        "iam:ListPolicyVersions",
        "iam:CreatePolicyVersion",
        "iam:DeletePolicyVersion",
        "iam:SetDefaultPolicyVersion",
        "iam:ListEntitiesForPolicy",
        "iam:TagPolicy",
        "iam:UntagPolicy",
      ],
      [...executionPolicyArns, identities.operatorPolicyArn, identities.applicationBoundaryArn],
    ),
    allow(
      "AttachToolkitPolicies",
      ["iam:AttachRolePolicy", "iam:DetachRolePolicy"],
      [identities.executionRoleArn, identities.deployRoleArn],
      { ArnEquals: { "iam:PolicyARN": [...executionPolicyArns, identities.operatorPolicyArn] } },
    ),
    allow(
      "ToolkitBucket",
      S3_BUCKET.filter((action) => action !== "s3:CreateBucket"),
      [assetArn],
    ),
    allow("CreateToolkitBucket", ["s3:CreateBucket"], [assetArn], r.bucketLocation),
    allow(
      "ToolkitImageRepository",
      [
        "ecr:CreateRepository",
        "ecr:DeleteRepository",
        "ecr:DescribeRepositories",
        "ecr:GetRepositoryPolicy",
        "ecr:SetRepositoryPolicy",
        "ecr:DeleteRepositoryPolicy",
        "ecr:GetLifecyclePolicy",
        "ecr:PutLifecyclePolicy",
        "ecr:DeleteLifecyclePolicy",
        "ecr:PutImageTagMutability",
        "ecr:PutImageScanningConfiguration",
        "ecr:ListTagsForResource",
        "ecr:TagResource",
        "ecr:UntagResource",
      ],
      [
        regional(
          "ecr",
          `repository/cdk-${identities.qualifier}-container-assets-${account}-${region}`,
        ),
      ],
    ),
    allow(
      "ToolkitVersion",
      [
        "ssm:PutParameter",
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:DeleteParameter",
        "ssm:AddTagsToResource",
        "ssm:RemoveTagsFromResource",
        "ssm:ListTagsForResource",
      ],
      [r.versionArn],
    ),
  ]);
  return {
    execution,
    executionParts,
    operator,
    setup,
    applicationBoundary,
    identities,
    limits: DEPLOYMENT_POLICY_LIMITS,
  };
}

/** Maximum application/runtime grants, never IAM management. Existing runner policies remain narrower. */
export function applicationRoleBoundary(scope: DeploymentPolicyScope): IamPolicyDocument {
  const r = scopeResources(scope);
  const { account, region } = scope;
  const competitor = installationCompetitorConfig(account, region, scope.environment);
  const buckets = r.bucketArns;
  const fileAssets = `arn:aws:s3:::${r.identities.assetBucketName}`;
  const boundary = document([
    allow(
      "Data",
      [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:ConditionCheckItem",
      ],
      [r.regional("dynamodb", "table/*"), r.regional("dynamodb", "table/*/index/*")],
      r.tagCondition,
    ),
    allow(
      "BucketMetadata",
      [
        "s3:GetBucketLocation",
        "s3:GetBucketTagging",
        "s3:GetBucketPolicy",
        "s3:PutBucketPolicy",
        "s3:ListBucket",
        "s3:ListBucketVersions",
      ],
      buckets,
      { StringEquals: { "s3:ResourceAccount": account } },
    ),
    allow(
      "PublishedAssets",
      [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:GetObjectTagging",
        "s3:PutObject",
        "s3:PutObjectTagging",
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts",
      ],
      buckets.map((arn) => `${arn}/*`),
      { StringEquals: { "s3:ResourceAccount": account } },
    ),
    allow("ReadBootstrapAssetBucket", ["s3:GetBucketLocation", "s3:ListBucket"], [fileAssets]),
    allow("ReadBootstrapAssets", ["s3:GetObject", "s3:GetObjectVersion"], [`${fileAssets}/*`]),
    allow(
      "Logs",
      [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams",
        "logs:GetLogEvents",
        "logs:FilterLogEvents",
      ],
      [
        r.regional("logs", "log-group:tenkacloud-cloud-*"),
        r.regional("logs", "log-group:/aws/lambda/tenkacloud-cloud-*"),
      ],
    ),
    allow("WorkflowLogDelivery", LOG_DELIVERY, ["*"], r.inRegion),
    allow(
      "InvokeWorkers",
      ["lambda:InvokeFunction"],
      [r.regional("lambda", "function:*")],
      r.tagCondition,
    ),
    allow(
      "StartWorkflow",
      ["states:StartExecution"],
      [r.regional("states", "stateMachine:*")],
      r.tagCondition,
    ),
    allow(
      "ReadWorkflowExecution",
      ["states:DescribeExecution"],
      [r.regional("states", "execution:tenkacloud-cloud-*:*")],
    ),
    allow(
      "InvalidateHosting",
      ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"],
      [`arn:aws:cloudfront::${account}:distribution/*`],
      r.tagCondition,
    ),
    allow("ReadInstallationExternalId", ["ssm:GetParameter"], [competitor.externalIdParameterArn]),
    allow("InitializeExternalId", ["ssm:PutParameter"], [competitor.externalIdParameterArn], {
      StringEquals: { "ssm:Overwrite": "false" },
    }),
    allow("CompetitorRoles", ["sts:AssumeRole"], [`arn:aws:iam::*:role/${competitor.roleName}`], {
      Null: { "sts:ExternalId": "false" },
      StringEquals: {
        "aws:ResourceTag/TenkaCloud:Purpose": "competitor-deploy",
        "aws:ResourceTag/TenkaCloud:Installation": competitor.roleName,
      },
    }),
    allow("ParticipantViewer", ["sts:AssumeRole"], ["arn:aws:iam::*:role/*"], {
      StringEquals: {
        "aws:ResourceTag/TenkaCloud:Purpose": "participant-viewer",
        "aws:ResourceTag/TenkaCloud:ProblemId": "hello-world",
        "aws:ResourceTag/TenkaCloud:OperatorAccount": account,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: IAM resolves this policy variable.
        "sts:ExternalId": "${aws:ResourceTag/TenkaCloud:JobId}",
      },
      ArnLike: {
        "aws:ResourceTag/TenkaCloud:StackId": "arn:aws:cloudformation:*:*:stack/tc-cloud-*/*",
      },
      Null: { "sts:ExternalId": "false", "aws:ResourceTag/TenkaCloud:JobId": "false" },
    }),
    ...(scope.runnerBindings?.length
      ? [
          allow(
            "LegacyCompetitorRoles",
            ["sts:AssumeRole"],
            [...new Set(scope.runnerBindings.map((binding) => binding.roleArn))],
          ),
          allow(
            "LegacyExternalIds",
            ["ssm:GetParameter"],
            [...new Set(scope.runnerBindings.map((binding) => binding.externalIdParameterArn))],
          ),
        ]
      : []),
    {
      Sid: "NeverAssumeControlPlaneRoles",
      Effect: "Deny",
      Action: ["sts:AssumeRole"],
      Resource: [`arn:aws:iam::${account}:role/*`],
    },
  ]);
  if (JSON.stringify(boundary).length > 6144)
    throw new Error(
      "Application boundary exceeds IAM's 6,144-character limit; reduce legacy bindings or review a dedicated boundary.",
    );
  return boundary;
}

interface TemplateResource {
  Type: string;
  Properties: Record<string, unknown>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
}

/** Read the pinned CDK template. Transforming a supplied template remains a pure operation. */
export function installedCdkBootstrapTemplate(): Record<string, unknown> {
  const require = createRequire(import.meta.url);
  const source = join(
    dirname(require.resolve("aws-cdk/package.json")),
    "lib/api/bootstrap/bootstrap-template.yaml",
  );
  return parseYaml(readFileSync(source, "utf8")) as Record<string, unknown>;
}

/**
 * Preserve the pinned CDK resource/output/version contract and replace its broad role grants.
 * Shape checks deliberately fail closed when a CDK upgrade adds another IAM resource.
 */
export function projectBootstrapTemplate(
  scope: DeploymentPolicyScope,
  stock = installedCdkBootstrapTemplate(),
) {
  const policies = deploymentPolicies(scope);
  const r = scopeResources(scope);
  const { identities } = policies;
  const template = structuredClone(stock) as {
    Description: string;
    Metadata?: Record<string, unknown>;
    Parameters: Record<string, Record<string, unknown>>;
    Resources: Record<string, TemplateResource>;
    Outputs: Record<string, Record<string, unknown>>;
    Conditions: Record<string, unknown>;
  };
  const { Resources, Parameters, Outputs } = template;
  const resource = (name: string): TemplateResource => {
    const value = Resources[name];
    if (!value) throw new Error(`Missing CDK bootstrap resource ${name}.`);
    return value;
  };
  const expectedIam = [
    "FilePublishingRole",
    "ImagePublishingRole",
    "LookupRole",
    "FilePublishingRoleDefaultPolicy",
    "ImagePublishingRoleDefaultPolicy",
    "DeploymentActionRole",
    "CloudFormationExecutionRole",
    "CdkBoostrapPermissionsBoundaryPolicy",
  ];
  const actualIam = Object.entries(Resources ?? {})
    .filter(([, resource]) => resource.Type.startsWith("AWS::IAM::"))
    .map(([name]) => name);
  if (
    JSON.stringify(actualIam.sort()) !== JSON.stringify(expectedIam.sort()) ||
    Resources.CdkBootstrapVersion?.Type !== "AWS::SSM::Parameter" ||
    Resources.StagingBucket?.Type !== "AWS::S3::Bucket" ||
    Resources.ContainerAssetsRepository?.Type !== "AWS::ECR::Repository" ||
    Outputs.BootstrapVersion?.Value !== Resources.CdkBootstrapVersion.Properties.Value
  ) {
    throw new Error(
      "Pinned CDK bootstrap resource contract changed; review the scoped transform before upgrading.",
    );
  }
  for (const name of [
    "FilePublishingRole",
    "ImagePublishingRole",
    "LookupRole",
    "DeploymentActionRole",
    "CloudFormationExecutionRole",
  ]) {
    if (Resources[name]?.Type !== "AWS::IAM::Role")
      throw new Error(`Unexpected CDK bootstrap role ${name}.`);
  }
  const fixed = (name: string, value: string) => {
    if (!Parameters[name]) throw new Error(`CDK bootstrap parameter ${name} is missing.`);
    // Keep the upstream parameter type, because its Conditions use list intrinsics.
    Parameters[name] = { ...Parameters[name], Default: value, AllowedValues: [value] };
  };
  fixed("Qualifier", identities.qualifier);
  fixed("BootstrapVariant", "TenkaCloud cloud-hosting v1");
  fixed("TrustedAccounts", "");
  fixed("TrustedAccountsForLookup", "");
  fixed("FileAssetsBucketName", "");
  fixed("ContainerAssetsRepositoryName", "");
  fixed("FileAssetsBucketKmsKeyId", "AWS_MANAGED_KEY");
  fixed("PublicAccessBlockConfiguration", "true");
  fixed("InputPermissionsBoundary", "");
  fixed("UseExamplePermissionsBoundary", "false");
  fixed("DenyExternalId", "true");
  Parameters.CloudFormationExecutionPolicies = {
    ...Parameters.CloudFormationExecutionPolicies,
    Default: identities.executionPolicyArns.join(","),
    AllowedValues: identities.executionPolicyArns,
  };
  const managed = (name: string, policy: IamPolicyDocument): TemplateResource => {
    if (JSON.stringify(policy).length > 6144)
      throw new Error(`${name} exceeds the IAM managed policy limit.`);
    return {
      Type: "AWS::IAM::ManagedPolicy",
      Properties: {
        ManagedPolicyName: `${scope.environment}-${scope.region}-${name}`,
        Path: "/tenkacloud/cloud-hosting/",
        PolicyDocument: policy,
      },
    };
  };
  policies.executionParts.forEach((policy, index) => {
    Resources[`ExecutionPolicy${index + 1}`] = managed(`execution-${index + 1}`, policy);
  });
  Resources.OperatorPolicy = managed("operator", policies.operator);
  Resources.ApplicationBoundary = managed("application-boundary", policies.applicationBoundary);
  const setRole = (
    name: string,
    kind: string,
    policy?: IamPolicyDocument,
    managedPolicies?: unknown[],
  ) => {
    const role = Resources[name];
    if (!role) throw new Error(`Missing bootstrap role ${name}.`);
    // Preserve same-account/session-tag behavior while making trust independent of
    // future upstream conditional branches or externally supplied trust parameters.
    role.Properties.AssumeRolePolicyDocument = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: kind === "cfn-exec" ? ["sts:AssumeRole"] : ["sts:AssumeRole", "sts:TagSession"],
          Principal:
            kind === "cfn-exec"
              ? { Service: "cloudformation.amazonaws.com" }
              : { AWS: `arn:aws:iam::${scope.account}:root` },
          ...(kind === "cfn-exec" ? {} : { Condition: { Null: { "sts:ExternalId": "true" } } }),
        },
      ],
    };
    role.Properties.RoleName = r.roleName(kind);
    delete role.Properties.ManagedPolicyArns;
    delete role.Properties.Policies;
    delete role.Properties.PermissionsBoundary;
    if (policy)
      role.Properties.Policies = [{ PolicyName: "TenkaCloudScoped", PolicyDocument: policy }];
    if (managedPolicies) role.Properties.ManagedPolicyArns = managedPolicies;
  };
  setRole(
    "CloudFormationExecutionRole",
    "cfn-exec",
    undefined,
    policies.executionParts.map((_, index) => ({ Ref: `ExecutionPolicy${index + 1}` })),
  );
  setRole("DeploymentActionRole", "deploy", undefined, [{ Ref: "OperatorPolicy" }]);
  setRole(
    "LookupRole",
    "lookup",
    document(
      policies.operator.Statement.filter((statement) =>
        ["ReadOwnedStacks", "BootstrapVersion"].includes(statement.Sid),
      ),
    ),
  );
  setRole("FilePublishingRole", "file-publishing");
  setRole("ImagePublishingRole", "image-publishing");
  // Keep the stock separate publishing-role policy resources and their attachment wiring.
  resource("FilePublishingRoleDefaultPolicy").Properties.PolicyDocument = document(
    policies.operator.Statement.filter((statement) =>
      ["AssetBucketMetadata", "FileAssets"].includes(statement.Sid),
    ),
  );
  resource("ImagePublishingRoleDefaultPolicy").Properties.PolicyDocument = document([
    allow(
      "PublishOwnedImages",
      [
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:BatchCheckLayerAvailability",
        "ecr:DescribeRepositories",
        "ecr:DescribeImages",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
      ],
      [
        r.regional(
          "ecr",
          `repository/cdk-${identities.qualifier}-container-assets-${scope.account}-${scope.region}`,
        ),
      ],
    ),
    allow("ImageAuthentication", ["ecr:GetAuthorizationToken"], ["*"], r.inRegion),
  ]);
  // The stock example boundary allows Action '*'. Keep its resource identity but
  // replace the disabled example with a deny-only policy, never an allow-all grant.
  resource("CdkBoostrapPermissionsBoundaryPolicy").Properties.PolicyDocument = document([
    {
      Sid: "UnusedExampleBoundary",
      Effect: "Deny",
      Action: ["iam:DeleteRolePermissionsBoundary"],
      Resource: ["*"],
    },
  ]);
  // A custom KMS key is disabled by an immutable parameter. Remove action wildcards
  // even from this unreachable stock key policy so inspection has no broad grants.
  resource("FileAssetsBucketEncryptionKey").Properties.KeyPolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${scope.account}:root` },
        Action: [
          "kms:DescribeKey",
          "kms:GetKeyPolicy",
          "kms:PutKeyPolicy",
          "kms:ScheduleKeyDeletion",
          "kms:CancelKeyDeletion",
          "kms:TagResource",
          "kms:UntagResource",
        ],
        Resource: "*",
      },
    ],
  };
  // Keep the stock transport deny, but enumerate the asset operations rather than s3:*.
  const bucketPolicy = resource("StagingBucketPolicy").Properties.PolicyDocument as {
    Statement: { Action: string | string[] }[];
  };
  const transportDeny = bucketPolicy.Statement[0];
  if (!transportDeny) throw new Error("CDK staging bucket transport policy is missing.");
  transportDeny.Action = [
    ...S3_BUCKET,
    "s3:GetObject",
    "s3:GetObjectVersion",
    "s3:PutObject",
    "s3:DeleteObject",
    "s3:DeleteObjectVersion",
    "s3:AbortMultipartUpload",
    "s3:ListMultipartUploadParts",
  ];
  Outputs.ExecutionPolicyArn = { Value: identities.executionPolicyArn };
  Outputs.ExecutionPolicyArns = { Value: identities.executionPolicyArns.join(",") };
  Outputs.OperatorPolicyArn = { Value: identities.operatorPolicyArn };
  Outputs.ApplicationBoundaryArn = { Value: identities.applicationBoundaryArn };
  template.Metadata = {
    ...template.Metadata,
    TenkaCloudSetupPermissions: policies.setup,
    TenkaCloudDeploymentLimits: policies.limits,
  };
  template.Description =
    "TenkaCloud cloud hosting: scoped transformation of the pinned AWS CDK bootstrap template.";
  if (Buffer.byteLength(JSON.stringify(template)) > 51200)
    throw new Error(
      "Generated setup template exceeds CloudFormation TemplateBody limit; reduce legacy bindings or use a reviewed S3 template delivery.",
    );
  return template;
}
