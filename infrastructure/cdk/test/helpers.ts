import { EventManager, type IEventManager } from "@cdklabs/sbt-aws";
import * as cdk from "aws-cdk-lib";
import { EventBus } from "aws-cdk-lib/aws-events";

/**
 * Create a lightweight EventManager for testing without Docker.
 * ControlPlaneStack requires Docker to build CognitoAuth's Python Lambdas,
 * so we create a standalone EventManager to test AppPlane and ProblemDeployPlane.
 */
export function createTestEventManager(
  app: cdk.App,
  stackId: string,
): {
  stack: cdk.Stack;
  eventManager: IEventManager;
} {
  const stack = new cdk.Stack(app, stackId);
  const eventBus = new EventBus(stack, "TestEventBus");
  const eventManager = new EventManager(stack, "TestEventManager", {
    eventBus,
  });
  return { stack, eventManager };
}
