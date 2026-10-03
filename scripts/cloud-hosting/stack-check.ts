import { z } from "zod";
import { cloudStackNames } from "../../infrastructure/lib/cloud-hosting/stack-names";

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
/** Original Lite and published cloud installations have distinct, established ownership tags. */
export function expectedStackTags(
  environment: string,
  nameOrArn: string,
): Readonly<Record<string, string>> {
  const name = nameOrArn.startsWith("arn:")
    ? nameOrArn.split(":stack/")[1]?.split("/")[0]
    : nameOrArn;
  for (const layout of ["lite", "cloud"] as const) {
    const names = cloudStackNames(environment, layout);
    if (name === names.app || name === names.backend)
      return layout === "lite"
        ? { Project: "TenkaCloud", Environment: environment }
        : { TenkaCloudProject: "cloud-hosting", Environment: environment };
  }
  throw new Error("Unknown installation stack identity; no resources were changed.");
}
/** Names alone are not ownership: require the resolved account/region ARN and installation tags. */
export function assertOwnedStack(output: string, identity: StackIdentity): string {
  const stack = stackSchema.parse(JSON.parse(output) as unknown);
  const arnPrefix = `arn:aws:cloudformation:${identity.region}:${identity.account}:stack/${identity.name}/`;
  const stackId = stack.StackId.slice(arnPrefix.length);
  const tagsMatch = Object.entries(expectedStackTags(identity.environment, identity.name)).every(
    ([key, value]) =>
      stack.Tags.filter((tag) => tag.Key === key && tag.Value === value).length === 1,
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
