import { z } from "zod";
import {
  type CloudStackLayout,
  cloudStackNames,
} from "../../infrastructure/lib/cloud-hosting/stack-names";
import type { ProcessResult } from "./process";
import { isMissingStack } from "./stack-check";

interface SelectionInput {
  readonly environment: string;
  readonly account: string;
  readonly region: string;
  readonly explicitLayout?: string;
  readonly run: (args: readonly string[]) => Promise<ProcessResult>;
}
const discoveredStack = z.object({
  StackName: z.string(),
  StackId: z.string(),
  StackStatus: z.string(),
});
async function stackExists(input: SelectionInput, name: string): Promise<boolean> {
  const result = await input.run([
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    name,
    "--region",
    input.region,
    "--query",
    "Stacks[0]",
    "--output",
    "json",
  ]);
  if (result.code !== 0 && isMissingStack(result.stderr, name)) return false;
  if (result.code !== 0)
    throw new Error(`Inspect existing installation ${name}: ${result.stderr.trim()}`);
  const parsed = discoveredStack.safeParse(JSON.parse(result.stdout) as unknown);
  if (
    !parsed.success ||
    parsed.data.StackName !== name ||
    !parsed.data.StackId.startsWith(
      `arn:aws:cloudformation:${input.region}:${input.account}:stack/${name}/`,
    )
  )
    throw new Error(
      `Existing stack identity is incomplete or does not match ${name}; no resources were changed.`,
    );
  return parsed.data.StackStatus !== "DELETE_COMPLETE";
}
/** Physical names are durable identities, independent of the product's display name. */
export async function selectCloudInstallation(input: SelectionInput): Promise<CloudStackLayout> {
  if (input.explicitLayout !== undefined) {
    if (input.explicitLayout !== "lite" && input.explicitLayout !== "cloud")
      throw new Error(
        "TENKACLOUD_STACK_LAYOUT must be lite or cloud; no AWS operation was started.",
      );
    return input.explicitLayout;
  }
  const present = new Set<CloudStackLayout>();
  for (const layout of ["lite", "cloud"] as const) {
    const names = cloudStackNames(input.environment, layout);
    for (const name of [names.app, names.backend]) {
      if (await stackExists(input, name)) present.add(layout);
    }
  }
  if (present.size > 1)
    throw new Error(
      `Both tenkacloud-lite and tenkacloud-cloud installations exist for ${input.environment}. No update or deletion was selected. Review their stack ARNs, then explicitly set TENKACLOUD_STACK_LAYOUT=lite or cloud for the intended installation. The other installation is left untouched.`,
    );
  return present.has("lite") ? "lite" : "cloud";
}
