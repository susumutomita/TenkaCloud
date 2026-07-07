import { isIP } from "node:net";
import YAML from "yaml";

export const ALLOWED_CIDR_PARAMETER_NAME = "AllowedCidr" as const;

export type AllowedCidrOverrideDecision =
  | { readonly kind: "not-declared" }
  | { readonly kind: "unconfigured"; readonly parameterType: string }
  | {
      readonly kind: "configured";
      readonly parameterValue: string;
      readonly parameterType: string;
      readonly configuredCidrCount: number;
      readonly injectedCidrCount: number;
    };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function validateCidr(cidr: string, sourceName: string): void {
  const slashIndex = cidr.lastIndexOf("/");
  if (slashIndex <= 0 || slashIndex === cidr.length - 1) {
    throw new Error(`${sourceName} entries must be CIDR blocks, got: ${cidr}`);
  }
  const ip = cidr.slice(0, slashIndex);
  const prefixText = cidr.slice(slashIndex + 1);
  const family = isIP(ip);
  if (family === 0) {
    throw new Error(`${sourceName} CIDR has an invalid IP address: ${cidr}`);
  }
  if (!/^[0-9]+$/.test(prefixText)) {
    throw new Error(`${sourceName} CIDR has an invalid prefix: ${cidr}`);
  }
  const prefix = Number(prefixText);
  const maxPrefix = family === 4 ? 32 : 128;
  if (prefix < 0 || prefix > maxPrefix) {
    throw new Error(`${sourceName} CIDR prefix must be between 0 and ${maxPrefix}: ${cidr}`);
  }
}

export function parseDeployAllowedCidrs(raw: string | undefined): readonly string[] | undefined {
  const cidrs =
    raw
      ?.split(",")
      .map((cidr) => cidr.trim())
      .filter((cidr) => cidr.length > 0) ?? [];
  if (cidrs.length === 0) return undefined;
  for (const cidr of cidrs) {
    validateCidr(cidr, "CDK_PARAM_DEPLOY_ALLOWED_CIDRS");
  }
  return cidrs;
}

export function resolveAllowedCidrParameterType(templateBody: string): string | undefined {
  // CFN templates use short-form intrinsics (!Ref/!Sub/...). yaml@1 keeps the
  // scalar's string value for unrecognized tags and records a warning rather
  // than throwing, and collects genuine syntax errors on `doc.errors` instead
  // of throwing, so no custom tag handlers or try/catch are needed here.
  const doc = YAML.parseDocument(templateBody);
  if (doc.errors.length > 0) {
    throw new Error(
      `template.yaml could not be parsed while checking ${ALLOWED_CIDR_PARAMETER_NAME}: ${doc.errors[0].message}`,
    );
  }
  const root = asRecord(doc.toJSON());
  const parameters = asRecord(root?.Parameters);
  if (!parameters || !(ALLOWED_CIDR_PARAMETER_NAME in parameters)) return undefined;
  const allowedCidr = asRecord(parameters[ALLOWED_CIDR_PARAMETER_NAME]);
  const rawType = allowedCidr?.Type;
  return typeof rawType === "string" && rawType.trim() !== "" ? rawType.trim() : "String";
}

function isCommaListParameter(parameterType: string): boolean {
  return parameterType === "CommaDelimitedList" || /^List<.+>$/.test(parameterType);
}

export function resolveAllowedCidrOverride(args: {
  readonly templateBody: string;
  readonly deployAllowedCidrs: readonly string[] | undefined;
}): AllowedCidrOverrideDecision {
  const parameterType = resolveAllowedCidrParameterType(args.templateBody);
  if (parameterType === undefined) return { kind: "not-declared" };
  if (!args.deployAllowedCidrs || args.deployAllowedCidrs.length === 0) {
    return { kind: "unconfigured", parameterType };
  }

  const injectedCidrs = isCommaListParameter(parameterType)
    ? args.deployAllowedCidrs
    : [args.deployAllowedCidrs[0]];
  return {
    kind: "configured",
    parameterValue: injectedCidrs.join(","),
    parameterType,
    configuredCidrCount: args.deployAllowedCidrs.length,
    injectedCidrCount: injectedCidrs.length,
  };
}
