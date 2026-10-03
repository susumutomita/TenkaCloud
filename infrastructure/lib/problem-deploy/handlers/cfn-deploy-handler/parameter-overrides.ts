/**
 * Issue #2291 / Issue #986 (SOLID split): CloudFormation `Parameters` array building
 * for the Lambda-based deploy create path (`create-stack.ts`).
 *
 * TypeScript port of the parameter-override portion of `scripts/lib/battles-common.sh`
 * `build_parameter_overrides`: always inject `NamePrefix` / `TenkaCloudAccountId` / `ExternalId`
 * (+ `AllowedCidr` when configured and declared), then the problem's `metadata.json`
 * `cfnParameters` with the `__RANDOM_PASSWORD__` token replaced by a fresh 32-char alphanumeric
 * secret, then any Composite-bound values (#2747).
 */

import { randomInt } from "node:crypto";
import { RESERVED_COMPOSITE_PARAMETER_NAMES } from "@tenkacloud/problem-runtime";
import {
  type AllowedCidrOverrideDecision,
  resolveAllowedCidrOverride,
} from "../../deploy-allowed-cidrs.js";

/**
 * `metadata.json` `cfnParameters` value token that means "generate a fresh 32-char secret at
 * deploy time" (mirrors `deploy-battles.sh`). Used for DbPassword-style parameters so no secret
 * is committed to the repo.
 */
export const RANDOM_PASSWORD_TOKEN = "__RANDOM_PASSWORD__" as const;

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * 32-char `[A-Za-z0-9]` (mirrors `tr -dc 'A-Za-z0-9' | head -c 32`).
 *
 * Uses `crypto.randomInt(max)` (rejection sampling internally) rather than
 * `randomBytes(n) % 62` — the latter is biased because 256 is not a multiple of
 * 62, so indices 0-7 would be drawn slightly more often (CodeQL: "biased random
 * numbers from a cryptographically secure source"). `randomInt` is uniform.
 */
export function generateRandomAlphanumeric(length = 32): string {
  const chars: string[] = [];
  for (let i = 0; i < length; i++) {
    chars.push(ALPHANUMERIC.charAt(randomInt(ALPHANUMERIC.length)));
  }
  return chars.join("");
}

export interface CfnParameter {
  readonly ParameterKey: string;
  readonly ParameterValue: string;
}

export interface BuildParameterOverridesArgs {
  /** `metadata.json` `cfnParameters` (problem-author declared). */
  readonly cfnParameters: Readonly<Record<string, string>>;
  readonly namePrefix: string;
  /** Platform (TenkaCloud) account id — the competitor template trusts it for cross-account. */
  readonly tenkaCloudAccountId: string;
  /**
   * The CFn `ExternalId` **parameter** value (distinct from the AssumeRole ExternalId). Mirrors
   * `PROBLEM_EXTERNAL_ID` in the shell path, which the state machine sets to the deploy jobId.
   * Must be >= 16 chars (competitor-bootstrap.yaml `MinLength`).
   */
  readonly externalId: string;
  /** Token generator for `__RANDOM_PASSWORD__` (injected for deterministic tests). */
  readonly generateToken: () => string;
  /** Problem template body, used to detect an optional `AllowedCidr` CFn parameter. */
  readonly templateBody?: string;
  /** Score-engine / operator-attacker egress CIDRs configured by the platform operator. */
  readonly deployAllowedCidrs?: readonly string[];
  /** Precomputed decision, passed by createStackForDeployment to avoid parsing the template twice. */
  readonly allowedCidrOverride?: AllowedCidrOverrideDecision;
  /**
   * [Composite Runtime / Issue #2747] Bound Composite input values (`DeployCreateRequestedDetail
   * .parameters`) — output values `composite-dispatch.ts` resolved from an upstream target and
   * forwards through `aws-cfn-adapter.ts`. Absent for every single-provider (non-Composite) deploy.
   * Reserved-name collisions with the three always-injected params (+ `AllowedCidr`) are already
   * rejected at plan-validation time (`@tenkacloud/problem-runtime` `RESERVED_COMPOSITE_PARAMETER_NAMES`);
   * this Lambda re-checks them (defense-in-depth, the actual CFn mutation boundary) and throws
   * loudly rather than letting a bound value silently clobber — or be clobbered by — a platform
   * parameter.
   */
  readonly boundParameters?: Readonly<Record<string, string>>;
}

const RESERVED_AWS_PARAMETER_NAMES = new Set(RESERVED_COMPOSITE_PARAMETER_NAMES.aws);

function resolveAllowedCidrDecision(
  args: Pick<
    BuildParameterOverridesArgs,
    "allowedCidrOverride" | "templateBody" | "deployAllowedCidrs"
  >,
): AllowedCidrOverrideDecision {
  if (args.allowedCidrOverride) return args.allowedCidrOverride;
  if (!args.templateBody) return { kind: "not-declared" };
  return resolveAllowedCidrOverride({
    templateBody: args.templateBody,
    deployAllowedCidrs: args.deployAllowedCidrs,
  });
}

/** Append the problem-author `cfnParameters`, resolving `__RANDOM_PASSWORD__` and skipping a duplicate `AllowedCidr`. */
function appendProblemParameters(
  overrides: CfnParameter[],
  args: Pick<BuildParameterOverridesArgs, "cfnParameters" | "generateToken">,
  allowedCidrOverride: AllowedCidrOverrideDecision,
): void {
  for (const [key, value] of Object.entries(args.cfnParameters)) {
    if (!key) continue;
    if (allowedCidrOverride.kind === "configured" && key === "AllowedCidr") continue;
    const resolved = value === RANDOM_PASSWORD_TOKEN ? args.generateToken() : value;
    overrides.push({ ParameterKey: key, ParameterValue: resolved });
  }
}

/**
 * Append Composite-bound values (#2747), rejecting a reserved-name collision loudly rather than
 * letting it silently clobber — or be clobbered by — a platform-injected parameter.
 */
function appendBoundParameters(
  overrides: CfnParameter[],
  boundParameters: Readonly<Record<string, string>> | undefined,
): void {
  for (const [key, value] of Object.entries(boundParameters ?? {})) {
    if (!key) continue;
    if (RESERVED_AWS_PARAMETER_NAMES.has(key)) {
      throw new Error(
        `composite-bound CFn parameter "${key}" collides with a platform-injected parameter name`,
      );
    }
    overrides.push({ ParameterKey: key, ParameterValue: value });
  }
}

/**
 * Build the CloudFormation `Parameters` array. Order + content mirror `build_parameter_overrides`
 * in `deploy-battles.sh`: the three always-injected params first, then the problem's declared
 * `cfnParameters` with `__RANDOM_PASSWORD__` resolved, then any Composite-bound values (#2747).
 */
export function buildParameterOverrides(args: BuildParameterOverridesArgs): CfnParameter[] {
  if (args.externalId.length < 16) {
    throw new Error("problem ExternalId (CFn parameter) must be at least 16 characters");
  }
  const allowedCidrOverride = resolveAllowedCidrDecision(args);
  const overrides: CfnParameter[] = [
    { ParameterKey: "NamePrefix", ParameterValue: args.namePrefix },
    { ParameterKey: "TenkaCloudAccountId", ParameterValue: args.tenkaCloudAccountId },
    { ParameterKey: "ExternalId", ParameterValue: args.externalId },
  ];
  if (allowedCidrOverride.kind === "configured") {
    overrides.push({
      ParameterKey: "AllowedCidr",
      ParameterValue: allowedCidrOverride.parameterValue,
    });
  }
  appendProblemParameters(overrides, args, allowedCidrOverride);
  appendBoundParameters(overrides, args.boundParameters);
  return overrides;
}
