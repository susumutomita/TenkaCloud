import { CoreApplicationPlane, type IEventManager, ScriptJob } from "@cdklabs/sbt-aws";
import * as cdk from "aws-cdk-lib";
import { NagSuppressions } from "cdk-nag";
import type { Construct } from "constructs";
import { EVENTS, EVENT_SOURCES } from "./constants/events";
import { buildDeployProblemScript } from "./handlers/deploy-problem";
import { buildMultiPolicy } from "./utils/iam-helpers";

export interface ProblemDeployPlaneStackProps extends cdk.StackProps {
  eventManager: IEventManager;
  appName: string;
  targetRoleName: string;
}

/**
 * Problem deployment engine Application Plane (ADR-011 Layer 2).
 *
 * Listens for "problem.deploy.requested" custom events from the problem-service
 * and deploys problem CloudFormation stacks into team AWS accounts via
 * cross-account STS AssumeRole.
 *
 * Script: scripts/deploy-problem.sh
 */
export class ProblemDeployPlaneStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ProblemDeployPlaneStackProps) {
    super(scope, id, props);

    const problemDeployRequested = props.eventManager.createCustomEvent(
      EVENTS.PROBLEM_DEPLOY_REQUESTED,
      EVENT_SOURCES.PROBLEM_SERVICE,
    );
    const problemDeployCompleted = props.eventManager.createCustomEvent(
      EVENTS.PROBLEM_DEPLOY_COMPLETED,
      EVENT_SOURCES.PROBLEM_DEPLOY_PLANE,
    );
    const problemDeployFailed = props.eventManager.createCustomEvent(
      EVENTS.PROBLEM_DEPLOY_FAILED,
      EVENT_SOURCES.PROBLEM_DEPLOY_PLANE,
    );

    const problemDeployJob = new ScriptJob(this, "ProblemDeployJob", {
      // deploymentKey = `${eventId}:${problemId}:${jobId}` (compound) so both
      // success and failure outgoing events can be mapped back to a single
      // DeploymentJob row in DynamoDB without scans.
      jobIdentifierKey: "deploymentKey",
      jobFailureStatus: { deployStatus: "failed" },
      permissions: buildMultiPolicy({
        actions: ["sts:AssumeRole"],
        resources: [`arn:aws:iam::*:role/${props.targetRoleName}`],
      }),
      script: buildDeployProblemScript(),
      incomingEvent: problemDeployRequested,
      outgoingEvent: {
        success: problemDeployCompleted,
        failure: problemDeployFailed,
      },
      environmentStringVariablesFromIncomingEvent: [
        "problemId",
        "teamId",
        "tenantId",
        "eventId",
        "jobId",
        "deploymentKey",
        "targetRoleArn",
        "externalId",
        "templateUrl",
      ],
      environmentVariablesToOutgoingEvent: {
        tenantData: ["deployStatus", "stackName", "stackId", "errorReason"],
      },
      scriptEnvironmentVariables: { APP_NAME: props.appName },
      eventManager: props.eventManager,
    });

    new CoreApplicationPlane(this, "ProblemDeployPlane", {
      eventManager: props.eventManager,
      scriptJobs: [problemDeployJob],
    });

    NagSuppressions.addStackSuppressions(this, [
      {
        id: "AwsSolutions-IAM5",
        reason: `Cross-account AssumeRole scoped to role name '${props.targetRoleName}' with account wildcard — required for multi-account problem deployment`,
      },
    ]);
  }
}
