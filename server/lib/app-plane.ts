import {
  CoreApplicationPlane,
  DeprovisioningScriptJob,
  type IEventManager,
  ProvisioningScriptJob,
  type TenantLifecycleScriptJobProps,
} from "@cdklabs/sbt-aws";
import * as cdk from "aws-cdk-lib";
import { NagSuppressions } from "cdk-nag";
import type { Construct } from "constructs";
import { buildProvisionScript } from "./handlers/provision";
import { buildDeprovisionScript } from "./handlers/deprovision";
import { buildMultiPolicy } from "./utils/iam-helpers";

export interface AppPlaneStackProps extends cdk.StackProps {
  eventManager: IEventManager;
  appName: string;
  dynamoDbTablePrefix: string;
  cfnStackPrefix: string;
}

/**
 * Tenant provisioning Application Plane (ADR-011 Layer 1).
 *
 * On tenant onboarding:  runs scripts/provision-tenant.sh
 * On tenant offboarding: runs scripts/deprovision-tenant.sh
 */
export class AppPlaneStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AppPlaneStackProps) {
    super(scope, id, props);

    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;
    const dynamoDbArn = `arn:aws:dynamodb:${region}:${account}:table/${props.dynamoDbTablePrefix}-*`;
    const cfnArn = `arn:aws:cloudformation:${region}:${account}:stack/${props.cfnStackPrefix}-*/*`;

    const sharedEnvVars = {
      TABLE_PREFIX: props.dynamoDbTablePrefix,
      APP_NAME: props.appName,
    };

    const provisioningJobProps: TenantLifecycleScriptJobProps = {
      permissions: buildMultiPolicy(
        {
          actions: ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Query"],
          resources: [dynamoDbArn],
        },
        {
          actions: [
            "cloudformation:CreateStack",
            "cloudformation:DescribeStacks",
            "cloudformation:DescribeStackResources",
          ],
          resources: [cfnArn],
        },
      ),
      script: buildProvisionScript(),
      environmentStringVariablesFromIncomingEvent: ["tenantId", "tier"],
      environmentVariablesToOutgoingEvent: { tenantData: ["tenantStatus"] },
      scriptEnvironmentVariables: sharedEnvVars,
      eventManager: props.eventManager,
    };

    const deprovisioningJobProps: TenantLifecycleScriptJobProps = {
      permissions: buildMultiPolicy(
        { actions: ["dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchWriteItem"], resources: [dynamoDbArn] },
        { actions: ["cloudformation:DeleteStack", "cloudformation:DescribeStacks"], resources: [cfnArn] },
      ),
      script: buildDeprovisionScript(),
      environmentStringVariablesFromIncomingEvent: ["tenantId"],
      environmentVariablesToOutgoingEvent: { tenantRegistrationData: ["registrationStatus"] },
      scriptEnvironmentVariables: sharedEnvVars,
      eventManager: props.eventManager,
    };

    const provisioningJob = new ProvisioningScriptJob(this, "ProvisioningJob", provisioningJobProps);
    const deprovisioningJob = new DeprovisioningScriptJob(this, "DeprovisioningJob", deprovisioningJobProps);

    new CoreApplicationPlane(this, "CoreApplicationPlane", {
      eventManager: props.eventManager,
      scriptJobs: [provisioningJob, deprovisioningJob],
    });

    NagSuppressions.addStackSuppressions(this, [
      {
        id: "AwsSolutions-IAM5",
        reason: `DynamoDB permissions scoped to table prefix '${props.dynamoDbTablePrefix}-*', CloudFormation permissions scoped to stack prefix '${props.cfnStackPrefix}-*'`,
      },
    ]);
  }
}
