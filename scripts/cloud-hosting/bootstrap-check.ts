import { z } from "zod";

export const STANDARD_TOOLKIT_STACK = "CDKToolkit";
export const STANDARD_TOOLKIT_QUALIFIER = "hnb659fds";

const stackSchema = z.object({
  StackName: z.string(),
  StackId: z.string(),
  StackStatus: z.string(),
  Parameters: z
    .array(z.object({ ParameterKey: z.string(), ParameterValue: z.string() }))
    .default([]),
  Outputs: z.array(z.object({ OutputKey: z.string(), OutputValue: z.string() })).default([]),
});

/** Check the selected stack, without imposing or changing its existing IAM configuration. */
export function assertStandardBootstrap(output: string, account: string, region: string): void {
  const stack = stackSchema.parse(JSON.parse(output) as unknown);
  const prefix = `arn:aws:cloudformation:${region}:${account}:stack/${STANDARD_TOOLKIT_STACK}/`;
  if (
    stack.StackName !== STANDARD_TOOLKIT_STACK ||
    !stack.StackId.startsWith(prefix) ||
    stack.StackId.length === prefix.length
  )
    throw new Error(
      "Existing CDKToolkit does not match the deployment account/region; no toolkit was changed.",
    );
  if (
    ![
      "CREATE_COMPLETE",
      "UPDATE_COMPLETE",
      "UPDATE_ROLLBACK_COMPLETE",
      "IMPORT_COMPLETE",
      "IMPORT_ROLLBACK_COMPLETE",
    ].includes(stack.StackStatus)
  )
    throw new Error(
      `CDKToolkit is ${stack.StackStatus}; resolve its state before deployment. No toolkit was changed.`,
    );
  const qualifiers = stack.Parameters.filter((parameter) => parameter.ParameterKey === "Qualifier");
  const versions = stack.Outputs.filter((output) => output.OutputKey === "BootstrapVersion");
  const version = versions[0]?.OutputValue ?? "";
  // DefaultStackSynthesizer currently requires bootstrap stack version 6.
  if (
    qualifiers.length > 1 ||
    qualifiers.some((parameter) => parameter.ParameterValue !== STANDARD_TOOLKIT_QUALIFIER) ||
    versions.length !== 1 ||
    !/^\d+$/u.test(version) ||
    Number(version) < 6
  )
    throw new Error(
      `Existing CDKToolkit is not compatible with the default qualifier ${STANDARD_TOOLKIT_QUALIFIER} and bootstrap version 6 or newer. Review its configuration with your AWS administrator and use the official CDK CLI separately for any required upgrade; no toolkit was changed.`,
    );
}
