import {
  CfnResource,
  CustomResourceProviderBase,
  type IAspect,
  RemovalPolicy,
  Stack,
} from "aws-cdk-lib";
import { CfnFunction } from "aws-cdk-lib/aws-lambda";
import { CfnLogGroup } from "aws-cdk-lib/aws-logs";
import type { IConstruct } from "constructs";
import { LAMBDA_LOG_RETENTION } from "../utils/lambda-runtime.js";

const FORMAT_OPTIONS = new Set(["LogFormat", "ApplicationLogLevel", "SystemLogLevel"]);

/** Own implicit Lambda logs in CFN without changing explicit logging configurations. */
export class OwnedRuntimeLogs implements IAspect {
  public visit(node: IConstruct): void {
    if (!(node instanceof CfnResource) || node.cfnResourceType !== "AWS::Lambda::Function") return;
    // CDK's S3 auto-delete provider uses a generic CfnResource rather than CfnFunction.
    if (!(node instanceof CfnFunction) && !(node.node.scope instanceof CustomResourceProviderBase))
      return;
    if (node.node.tryFindChild("OwnedRuntimeLogs") || !this.canAddDefaultGroup(node)) return;
    const logs = new CfnLogGroup(node, "OwnedRuntimeLogs", {
      // CFN-generated names avoid adopting old/precreated groups or cycling with Function Ref.
      retentionInDays: LAMBDA_LOG_RETENTION,
    });
    logs.applyRemovalPolicy(RemovalPolicy.DESTROY);
    node.addPropertyOverride("LoggingConfig.LogGroup", logs.ref);
  }

  private canAddDefaultGroup(node: CfnResource): boolean {
    // The pinned CDK provider has no public logging prop. Inspect rendered CFN,
    // including caller overrides, before adding a default. Keep this CDK adapter
    // isolated and regression-tested on library upgrades; never inspect private fields.
    const template = Stack.of(node).resolve(node._toCloudFormation()) as {
      Resources: Record<string, { Properties?: { LoggingConfig?: unknown } }>;
    };
    const configuration = Object.values(template.Resources)[0]?.Properties?.LoggingConfig;
    if (configuration === undefined) return true;
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration))
      return false;
    // Preserve explicit destinations and unresolved/conditional configurations.
    // Format-only settings can still use a managed destination without being changed.
    return Object.entries(configuration)
      .filter(([, value]) => value !== undefined)
      .every(([key]) => FORMAT_OPTIONS.has(key));
  }
}
