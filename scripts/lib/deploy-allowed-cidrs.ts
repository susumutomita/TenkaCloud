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

export function resolveAllowedCidrParameterType(templateBody: string): string | undefined {
  // CFN templates use short-form intrinsics (!Ref/!Sub/...). yaml@1 keeps the
  // scalar's string value for unrecognized tags and records a warning rather
  // than throwing, and collects genuine syntax errors on `doc.errors` instead
  // of throwing, so no custom tag handlers or try/catch are needed here.
  const doc = YAML.parseDocument(templateBody);
  if (doc.errors.length > 0) {
    throw new Error(
      `template.yaml could not be parsed while checking ${ALLOWED_CIDR_PARAMETER_NAME}: ${doc.errors[0]?.message}`,
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
