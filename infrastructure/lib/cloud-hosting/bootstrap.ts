import { createHash } from "node:crypto";
import { cloudStackNames } from "./stack-names.js";

/** Isolated from the shared/default CDKToolkit and stable for both project stacks. */
export function projectBootstrap(environment: string) {
  cloudStackNames(environment);
  return {
    stackName: `TenkaCloudToolkit-${environment}`,
    qualifier: `tc${createHash("sha256").update(environment).digest("hex").slice(0, 7)}`,
  };
}
export function requireExecutionPolicy(value: string | undefined): {
  arn: string;
  account: string;
} {
  const match =
    /^arn:aws:iam::(\d{12}):policy\/tenkacloud\/cloud-hosting\/[A-Za-z0-9_+=.@/-]+$/u.exec(
      value ?? "",
    );
  if (!match?.[1] || !value || value.length > 2048)
    throw new Error(
      "Set TENKACLOUD_CFN_EXECUTION_POLICY_ARN to a reviewed, least-privilege account policy under policy/tenkacloud/cloud-hosting/. No AdministratorAccess fallback is allowed.",
    );
  return { arn: value, account: match[1] };
}
