import { z } from "zod";
import { cloudStackTags } from "../../infrastructure/lib/cloud-hosting/stack-names";

const stackSchema = z.object({
  StackId: z.string(),
  StackName: z.string(),
  Tags: z.array(z.object({ Key: z.string(), Value: z.string() })),
});
export interface StackIdentity {
  readonly account: string;
  readonly region: string;
  readonly environment: string;
  readonly name: string;
}
/** Names alone are not ownership: require the resolved account/region ARN and installation tags. */
export function assertOwnedStack(output: string, identity: StackIdentity): string {
  const stack = stackSchema.parse(JSON.parse(output) as unknown);
  const arnPrefix = `arn:aws:cloudformation:${identity.region}:${identity.account}:stack/${identity.name}/`;
  const stackId = stack.StackId.slice(arnPrefix.length);
  const tagsMatch = Object.entries(cloudStackTags(identity.environment)).every(([key, value]) =>
    stack.Tags.some((tag) => tag.Key === key && tag.Value === value),
  );
  if (
    stack.StackName !== identity.name ||
    !stack.StackId.startsWith(arnPrefix) ||
    !/^[a-zA-Z0-9-]+$/u.test(stackId) ||
    !tagsMatch
  ) {
    throw new Error(
      `Stack ${identity.name} ownership or account/region does not match; refusing to modify it.`,
    );
  }
  return stack.StackId;
}
export function isMissingStack(stderr: string, name: string): boolean {
  return (
    stderr.includes("(ValidationError)") && stderr.includes(`Stack with id ${name} does not exist`)
  );
}

/** Never infer a runner-less deployment from missing metadata or an accidentally omitted setting. */
export function assertRunnerChange(output: string, mode: "up" | "down", configured: boolean): void {
  const stack = z
    .object({
      StackId: z.string(),
      Outputs: z.array(z.object({ OutputKey: z.string(), OutputValue: z.string() })),
    })
    .parse(JSON.parse(output) as unknown);
  const settings = stack.Outputs.filter((entry) => entry.OutputKey === "CloudRunnerEnabled");
  const enabled = settings[0]?.OutputValue;
  if (settings.length !== 1 || (enabled !== "true" && enabled !== "false"))
    throw new Error(
      "Existing CloudRunnerEnabled is missing or ambiguous; review the stack before changing it.",
    );
  if (enabled === "false") return;
  if (mode === "up" && !configured)
    throw new Error(
      "Existing runner is enabled; refusing an update without TENKACLOUD_RUNNER_BINDINGS before it can remove the runner.",
    );
  if (mode === "down")
    throw new Error(
      `Runner-enabled stack ${stack.StackId} cannot be destroyed by this command yet. Stop acceptance, drain pending and active executions, then review owned problem stacks and retained data, CDK asset and execution-artifact buckets before coordinated platform teardown. No resources were removed.`,
    );
}
