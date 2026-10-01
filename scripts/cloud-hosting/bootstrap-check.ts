import { z } from "zod";
import { projectBootstrap } from "../../infrastructure/lib/cloud-hosting/bootstrap";

const stackSchema = z.object({
  Tags: z.array(z.object({ Key: z.string(), Value: z.string() })),
  Parameters: z.array(z.object({ ParameterKey: z.string(), ParameterValue: z.string() })),
});
/** Never replace another project's toolkit or silently widen an existing execution grant. */
export function assertOwnedBootstrap(output: string, environment: string, policyArn: string): void {
  const stack = stackSchema.parse(JSON.parse(output) as unknown);
  const tag = (key: string) => stack.Tags.find((item) => item.Key === key)?.Value;
  const parameter = (key: string) =>
    stack.Parameters.find((item) => item.ParameterKey === key)?.ParameterValue;
  if (
    tag("TenkaCloudProject") !== "cloud-hosting" ||
    tag("Environment") !== environment ||
    parameter("Qualifier") !== projectBootstrap(environment).qualifier ||
    parameter("CloudFormationExecutionPolicies") !== policyArn
  ) {
    throw new Error(
      "Existing toolkit ownership or execution policy does not match; refusing to modify it.",
    );
  }
}
