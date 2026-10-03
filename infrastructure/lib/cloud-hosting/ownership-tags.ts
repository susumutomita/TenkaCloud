import { Aspects, CfnResource, type Stack, Tags } from "aws-cdk-lib";
import { CfnRole } from "aws-cdk-lib/aws-iam";

/** Preserve ownership metadata for application roles and built-in CDK providers. */
export function applyOwnershipTags(stack: Stack, environment: string): void {
  Tags.of(stack).add("TenkaCloudRegion", stack.region);
  Aspects.of(stack).add({
    visit(node) {
      if (node instanceof CfnRole) {
        node.tags.setTag("Project", "TenkaCloud");
        node.tags.setTag("TenkaCloudProject", "cloud-hosting");
        node.tags.setTag("Environment", environment);
        node.tags.setTag("TenkaCloudRegion", stack.region);
      } else if (node instanceof CfnResource && node.cfnResourceType === "AWS::IAM::Role") {
        // CDK's built-in S3 cleanup provider creates a generic CfnResource role,
        // which the normal role TagManager does not visit.
        node.addPropertyOverride("Tags", [
          { Key: "Project", Value: "TenkaCloud" },
          { Key: "TenkaCloudProject", Value: "cloud-hosting" },
          { Key: "Environment", Value: environment },
          { Key: "TenkaCloudRegion", Value: stack.region },
        ]);
      }
    },
  });
}
