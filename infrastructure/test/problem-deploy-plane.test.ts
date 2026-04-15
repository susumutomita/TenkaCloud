import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { ProblemDeployPlaneStack } from "../lib/problem-deploy-plane";
import { createTestEventManager } from "./helpers";

describe("ProblemDeployPlaneStack", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const { eventManager } = createTestEventManager(app, "TestEventManagerStack");
    const stack = new ProblemDeployPlaneStack(app, "TestProblemDeployPlane", {
      eventManager,
      appName: "TestApp",
      targetRoleName: "test-deploy-role",
    });
    template = Template.fromStack(stack);
  });

  describe("when synthesized", () => {
    it("should create a CodeBuild project for problem deployment", () => {
      template.resourceCountIs("AWS::CodeBuild::Project", 1);
    });

    it("should create a Step Functions state machine", () => {
      template.resourceCountIs("AWS::StepFunctions::StateMachine", 1);
    });
  });

  describe("EventBridge integration", () => {
    it("should create a rule listening for problem.deploy.requested events", () => {
      template.hasResourceProperties("AWS::Events::Rule", {
        EventPattern: {
          source: ["tenkacloud.problem-service"],
          "detail-type": ["problem.deploy.requested"],
        },
      });
    });
  });

  describe("IAM permissions", () => {
    it("should create IAM roles for cross-account deployment", () => {
      const roles = template.findResources("AWS::IAM::Role");
      expect(Object.keys(roles).length).toBeGreaterThanOrEqual(1);
    });
  });
});
