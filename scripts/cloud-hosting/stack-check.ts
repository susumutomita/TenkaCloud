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

/** Registry configuration is durable. Never drop or replace legacy bindings by omission. */
export function assertRunnerChange(output: string, bindingsDigest: string): void {
  const stack = z
    .object({ Outputs: z.array(z.object({ OutputKey: z.string(), OutputValue: z.string() })) })
    .parse(JSON.parse(output) as unknown);
  const value = (key: string) => {
    const entries = stack.Outputs.filter((entry) => entry.OutputKey === key);
    if (entries.length !== 1)
      throw new Error(
        `Existing ${key} is missing or ambiguous; review the stack before changing it.`,
      );
    return entries[0]?.OutputValue;
  };
  const enabled = value("CloudRunnerEnabled");
  if (enabled !== "true" && enabled !== "false")
    throw new Error("Invalid CloudRunnerEnabled output.");
  if (enabled === "false") return;
  const mode = value("CloudRunnerMode");
  const digest = value("CloudLegacyBindingsDigest");
  if (
    !["registry", "registry-with-legacy-bindings"].includes(mode ?? "") ||
    !/^[a-f0-9]{64}$/u.test(digest ?? "")
  )
    throw new Error(
      "Existing runner configuration cannot be safely compared. Preserve the deployed runner and review its legacy bindings.",
    );
  if (digest !== bindingsDigest)
    throw new Error(
      "TENKACLOUD_RUNNER_BINDINGS differs from the deployed legacy bindings. Refusing to remove or change credentials needed by stored event work.",
    );
}
