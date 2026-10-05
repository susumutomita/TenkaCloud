import { z } from "zod";
import type { CloudControlDataConfiguration } from "../../infrastructure/lib/cloud-hosting/config";
import { assertHistoricalLiteTemplate } from "../../infrastructure/lib/cloud-hosting/historical-lite";
import type { PlatformStack } from "./failed-creation";

export const RESTORED_COMPOSITION = "lite-baseline-v1";
const templateSchema = z.object({
  TemplateBody: z.object({
    Metadata: z.record(z.string(), z.unknown()).optional(),
    Resources: z.record(
      z.string(),
      z.object({ Type: z.string(), Properties: z.record(z.string(), z.unknown()).optional() }),
    ),
    Outputs: z.record(z.string(), z.object({ Value: z.unknown() })).optional(),
  }),
});
const publishedOutputs = [
  "CloudRunnerEnabled",
  "CloudInstallationControlVersion",
  "CloudRunnerMode",
  "CloudLegacyBindingsDigest",
  "CloudExecutionCatalogKey",
];

/** Restore is not an in-place migration: Cognito and data logical IDs/schema differ. */
export function assertCompatibleStack(
  stack: PlatformStack,
  templateJson: string,
): CloudControlDataConfiguration | undefined {
  const { TemplateBody: template } = templateSchema.parse(JSON.parse(templateJson) as unknown);
  const published =
    publishedOutputs.some(
      (key) => Object.hasOwn(stack.outputs, key) || Object.hasOwn(template.Outputs ?? {}, key),
    ) ||
    Object.entries(template.Resources).some(
      ([id, resource]) =>
        (resource.Type === "AWS::Cognito::UserPool" && /^OrganizerUserPool[A-F0-9]*$/u.test(id)) ||
        (resource.Type === "AWS::DynamoDB::Table" &&
          /^(Events|Teams|Deployments)[A-F0-9]*$/u.test(id)) ||
        (resource.Type === "AWS::Lambda::Function" && /^CloudApi[A-F0-9]*$/u.test(id)),
    );
  if (published)
    throw new Error(
      `Stack ${stack.name} uses the published cloud-v1 resource layout. Its database schema and Cognito/resource logical IDs are incompatible with the restored competition backend. Deployment stopped before bootstrap, source upload or AWS mutation. Keep this installation on its matching release and export/back up its data; deploy the restored backend with a different ENV (and a separate Turso database, when applicable), or plan an explicit migration. No automatic migration or data deletion is performed. Existing make destroy remains available for operator-approved recovery.`,
    );
  if (
    stack.outputs.CloudComposition === RESTORED_COMPOSITION &&
    template.Metadata?.TenkaCloudCloudComposition === RESTORED_COMPOSITION
  )
    return undefined;
  if (stack.name === "tenkacloud-lite" || stack.name.startsWith("tenkacloud-lite-"))
    return assertHistoricalLiteTemplate(
      template,
      stack.name.includes("-problem-deploy") ? "backend" : "app",
    );
  throw new Error(
    `Stack ${stack.name} does not prove the ${RESTORED_COMPOSITION} resource contract. Deployment stopped before mutation to avoid replacing an unknown database or Cognito pool. Inspect its template and use a separate ENV or an explicit migration; no resources were changed.`,
  );
}
