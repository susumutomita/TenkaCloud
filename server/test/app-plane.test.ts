import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AppPlaneStack } from "../lib/app-plane";
import { createTestEventManager } from "./helpers";

describe("AppPlaneStack", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const { eventManager } = createTestEventManager(app, "TestEventManagerStack");
    const stack = new AppPlaneStack(app, "TestAppPlane", {
      eventManager,
      appName: "TestApp",
      dynamoDbTablePrefix: "TestApp",
      cfnStackPrefix: "tenant",
    });
    template = Template.fromStack(stack);
  });

  describe("when synthesized", () => {
    it("should create CodeBuild projects for provisioning and deprovisioning", () => {
      template.resourceCountIs("AWS::CodeBuild::Project", 2);
    });

    it("should create Step Functions state machines for each lifecycle job", () => {
      template.resourceCountIs("AWS::StepFunctions::StateMachine", 2);
    });

    it("should create IAM roles for CodeBuild execution", () => {
      const roles = template.findResources("AWS::IAM::Role");
      expect(Object.keys(roles).length).toBeGreaterThanOrEqual(2);
    });
  });
});
