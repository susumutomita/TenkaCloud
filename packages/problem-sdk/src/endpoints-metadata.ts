/**
 * Issue #2106: pure `metadata.json:endpoints[]`
 * section parser — single source of truth shared by the platform Endpoint
 * registry (CDK synth + Lambda runtime) and external Pack authoring. The infra
 * copy re-exports from here. The env-decoding helper (`parseEndpointsEnv`) stays
 * in infra (it needs `node:zlib`); everything here is pure and deterministic.
 */

export interface ProblemEndpointSlotDefault {
  /** Source of the default URL. Currently only `cfn-output`. */
  readonly from: "cfn-output";
  /** CFn template Outputs OutputKey (e.g. "FrontendUrl"). */
  readonly key: string;
  /** Path appended to the OutputKey value (e.g. "/users"). */
  readonly appendPath?: string;
}

export interface ProblemEndpointSlot {
  readonly slot: string;
  readonly default: ProblemEndpointSlotDefault;
  /** Whether a competitor can override the URL in the portal. Unset = false. */
  readonly overridable: boolean;
  readonly label?: string;
  readonly description?: string;
}

/**
 * Narrow one `endpoints[]` entry to {@link ProblemEndpointSlot}, or `undefined`
 * when malformed. `slot` / `default.from === "cfn-output"` / `default.key` are
 * required; `overridable` defaults to false; unknown fields are ignored.
 */
export function parseEndpointSlot(value: unknown): ProblemEndpointSlot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as {
    slot?: unknown;
    default?: unknown;
    overridable?: unknown;
    label?: unknown;
    description?: unknown;
  };
  if (typeof v.slot !== "string" || v.slot.length === 0) return undefined;
  if (!v.default || typeof v.default !== "object") return undefined;
  const d = v.default as { from?: unknown; key?: unknown; appendPath?: unknown };
  if (d.from !== "cfn-output") return undefined;
  if (typeof d.key !== "string" || d.key.length === 0) return undefined;
  return {
    slot: v.slot,
    default: {
      from: "cfn-output",
      key: d.key,
      ...(typeof d.appendPath === "string" ? { appendPath: d.appendPath } : {}),
    },
    overridable: v.overridable === true,
    ...(typeof v.label === "string" ? { label: v.label } : {}),
    ...(typeof v.description === "string" ? { description: v.description } : {}),
  };
}

function tryUrl(input: string, base?: string): string | undefined {
  try {
    return new URL(input, base).toString();
  } catch {
    return undefined;
  }
}

/** Compute the effective default URL from `default.key` + `default.appendPath`. */
export function resolveDefaultUrl(base: string, appendPath?: string): string | undefined {
  if (!appendPath) return base;
  const baseWithSlash = base.endsWith("/") ? base : `${base}/`;
  return tryUrl(appendPath) ?? tryUrl(appendPath, baseWithSlash);
}
